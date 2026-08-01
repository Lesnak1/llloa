/**
 * Trading Strategy — Hybrid Momentum + Mean-Reversion
 * 
 * Analyzes candle data for each asset, produces actionable signals
 * with entry/exit prices and confidence scores.
 */

const {
  calculateRSI,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  analyzeVolume,
  calculateMomentum,
  latest,
} = require('./indicators');

/* ────────────────────── Signal Types ──────────────────────── */

const Signal = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  HOLD: 'HOLD',
  SELL: 'SELL',
  STRONG_SELL: 'STRONG_SELL',
};

const SIGNAL_STRENGTH = {
  [Signal.STRONG_BUY]: 5,
  [Signal.BUY]: 3,
  [Signal.HOLD]: 0,
  [Signal.SELL]: -3,
  [Signal.STRONG_SELL]: -5,
};

/* ────────────────── Analyze a Single Asset ─────────────────── */

/**
 * Produce a trading signal from OHLCV candle data.
 * 
 * @param {Array<{time,open,high,low,close,volume}>} candles  - sorted oldest→newest
 * @param {string} tokenName
 * @returns {{
 *   tokenName: string,
 *   signal: string,
 *   strength: number,       // -5..5 (magnitude of conviction)
 *   score: number,          // composite 0–100
 *   entryPrice: number,
 *   stopLoss: number,
 *   takeProfit: number,
 *   currentPrice: number,
 *   rsi: number,
 *   ema9: number,
 *   ema21: number,
 *   atr: number,
 *   volumeTrend: string,
 *   momentum: number,
 *   reason: string,
 * }}
 */
function analyzeAsset(candles, tokenName) {
  const result = {
    tokenName,
    signal: Signal.HOLD,
    strength: 0,
    score: 50,
    entryPrice: 0,
    stopLoss: 0,
    takeProfit: 0,
    currentPrice: 0,
    rsi: 50,
    ema9: 0,
    ema21: 0,
    atr: 0,
    volumeTrend: 'normal',
    momentum: 0,
    reason: 'Insufficient data',
  };

  if (!candles || candles.length < 30) return result;

  // Extract OHLCV arrays
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const volumes = candles.map((c) => Number(c.volume || 0));

  const currentPrice = closes[closes.length - 1];
  result.currentPrice = currentPrice;

  // ── Calculate indicators ──
  const rsiArr = calculateRSI(closes, 14);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const { macd: macdLine, signal: signalLine, histogram } = calculateMACD(closes);
  const { upper: bbUpper, middle: bbMiddle, lower: bbLower } = calculateBollingerBands(closes, 20);
  const atrArr = calculateATR(highs, lows, closes, 14);
  const volAnalysis = analyzeVolume(volumes);
  const momentum = calculateMomentum(closes, 10);

  const rsi = latest(rsiArr) ?? 50;
  const e9 = latest(ema9) ?? currentPrice;
  const e21 = latest(ema21) ?? currentPrice;
  const macdVal = latest(macdLine) ?? 0;
  const macdSignal = latest(signalLine) ?? 0;
  const macdHist = latest(histogram) ?? 0;
  const bbU = latest(bbUpper) ?? currentPrice * 1.05;
  const bbL = latest(bbLower) ?? currentPrice * 0.95;
  const atr = latest(atrArr) ?? currentPrice * 0.02;

  result.rsi = Math.round(rsi * 100) / 100;
  result.ema9 = Math.round(e9 * 100) / 100;
  result.ema21 = Math.round(e21 * 100) / 100;
  result.atr = Math.round(atr * 100) / 100;
  result.volumeTrend = volAnalysis.trend;
  result.momentum = Math.round(momentum * 100) / 100;

  // ── Multi-Timeframe Alignment (1H Macro Trend calculated from 15m candles) ──
  // EMA(36) on 15m candles = 9-period EMA on 1h candles
  // EMA(84) on 15m candles = 21-period EMA on 1h candles
  const emaMacroShort = calculateEMA(closes, 36);
  const emaMacroLong = calculateEMA(closes, 84);
  const eMacroShort = latest(emaMacroShort) ?? currentPrice;
  const eMacroLong = latest(emaMacroLong) ?? currentPrice;
  const isMacroBullish = eMacroShort > eMacroLong;
  const isMacroBearish = eMacroShort < eMacroLong;

  // ── Scoring system: accumulate points ──
  //    Positive = bullish, Negative = bearish
  let score = 0;
  const reasons = [];

  // Multi-Timeframe Alignment Bonus (Hedge Fund Institutional Quant Rule)
  if (isMacroBullish) {
    score += 15;
    reasons.push('1H Macro Trend Bullish (EMA36 > EMA84)');
  } else if (isMacroBearish) {
    score -= 15;
    reasons.push('1H Macro Trend Bearish (EMA36 < EMA84)');
  }

  // RSI
  if (rsi < 25) { score += 25; reasons.push(`RSI deeply oversold (${rsi.toFixed(1)})`); }
  else if (rsi < 35) { score += 15; reasons.push(`RSI oversold (${rsi.toFixed(1)})`); }
  else if (rsi > 75) { score -= 25; reasons.push(`RSI deeply overbought (${rsi.toFixed(1)})`); }
  else if (rsi > 65) { score -= 15; reasons.push(`RSI overbought (${rsi.toFixed(1)})`); }

  // EMA crossover
  if (e9 > e21) { score += 15; reasons.push('EMA9 > EMA21 (bullish trend)'); }
  else if (e9 < e21) { score -= 15; reasons.push('EMA9 < EMA21 (bearish trend)'); }

  // EMA cross momentum (how recently did the cross happen)
  if (ema9.length >= 3 && ema21.length >= 3) {
    const prev9 = ema9[ema9.length - 3];
    const prev21 = ema21[ema21.length - 3];
    if (!isNaN(prev9) && !isNaN(prev21)) {
      if (prev9 <= prev21 && e9 > e21) { score += 10; reasons.push('Fresh bullish EMA cross'); }
      else if (prev9 >= prev21 && e9 < e21) { score -= 10; reasons.push('Fresh bearish EMA cross'); }
    }
  }

  // MACD
  if (macdHist > 0 && macdVal > macdSignal) { score += 10; reasons.push('MACD bullish'); }
  else if (macdHist < 0 && macdVal < macdSignal) { score -= 10; reasons.push('MACD bearish'); }

  // Bollinger Band mean reversion
  if (currentPrice < bbL) { score += 20; reasons.push('Price below lower Bollinger Band'); }
  else if (currentPrice > bbU) { score -= 20; reasons.push('Price above upper Bollinger Band'); }

  // Momentum
  if (momentum > 3) { score += 10; reasons.push(`Strong positive momentum (${momentum.toFixed(1)}%)`); }
  else if (momentum > 1) { score += 5; reasons.push(`Positive momentum (${momentum.toFixed(1)}%)`); }
  else if (momentum < -3) { score -= 10; reasons.push(`Strong negative momentum (${momentum.toFixed(1)}%)`); }
  else if (momentum < -1) { score -= 5; reasons.push(`Negative momentum (${momentum.toFixed(1)}%)`); }

  // Volume confirmation
  if (volAnalysis.trend === 'spike') {
    score *= 1.3;  // amplify signal
    reasons.push('Volume spike confirms signal');
  } else if (volAnalysis.trend === 'high') {
    score *= 1.1;
    reasons.push('Above-average volume');
  } else if (volAnalysis.trend === 'low') {
    score *= 0.7;  // dampen signal on low volume
    reasons.push('Low volume — signal less reliable');
  }

  // ── Map composite score to signal (Aggressive Tournament Thresholds) ──
  let signal, strength;

  if (score >= 25) {
    signal = Signal.STRONG_BUY;
    strength = 5;
  } else if (score >= 12) {
    signal = Signal.BUY;
    strength = 3;
  } else if (score <= -25) {
    signal = Signal.STRONG_SELL;
    strength = -5;
  } else if (score <= -12) {
    signal = Signal.SELL;
    strength = -3;
  } else {
    signal = Signal.HOLD;
    strength = 0;
  }

  // ── Entry, stop-loss, take-profit ──
  const entryPrice = signal === Signal.BUY || signal === Signal.STRONG_BUY
    ? currentPrice                    // buy at current market
    : signal === Signal.SELL || signal === Signal.STRONG_SELL
      ? currentPrice                  // sell at current market
      : 0;

  const atrMultiple = signal === Signal.STRONG_BUY || signal === Signal.STRONG_SELL ? 1.5 : 2;
  const stopLoss = strength > 0
    ? currentPrice - atr * atrMultiple
    : strength < 0
      ? currentPrice + atr * atrMultiple
      : 0;

  const takeProfit = strength > 0
    ? currentPrice + atr * 3
    : strength < 0
      ? currentPrice - atr * 3
      : 0;

  result.signal = signal;
  result.strength = strength;
  result.score = Math.round(score);
  result.entryPrice = Math.round(entryPrice * 100) / 100;
  result.stopLoss = Math.round(stopLoss * 100) / 100;
  result.takeProfit = Math.round(takeProfit * 100) / 100;
  result.reason = reasons.join(' | ');

  return result;
}

/* ──────────── Rank opportunities across all assets ──────────── */

/**
 * Sort analyzed signals by strength (most actionable first).
 * @param {Array} analyses - results from analyzeAsset()
 * @returns {Array} sorted: buys first (descending strength), sells (ascending)
 */
function rankOpportunities(analyses) {
  const actionable = analyses.filter((a) => a.signal !== Signal.HOLD);
  return actionable.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

/* ──────── Check if existing position should be closed ──────── */

/**
 * Evaluate an existing position against current market conditions.
 * @param {Object} position  - { tokenName, quantity, avgEntryPrice, side }
 * @param {number} currentPrice
 * @param {Object} analysis  - from analyzeAsset()
 * @returns {{ shouldClose: boolean, reason: string }}
 */
function shouldClosePosition(position, currentPrice, analysis) {
  const entry = Number(position.averageEntryPrice || position.avgEntryPrice || position.averagePrice || 0);
  const qty = Number(position.quantity || position.tokenQuantity || 0);
  if (!entry || !qty) return { shouldClose: false, reason: 'No valid position data' };

  const isLong = qty > 0;
  const pnlPct = isLong
    ? ((currentPrice - entry) / entry) * 100
    : ((entry - currentPrice) / entry) * 100;

  // High-Velocity Tournament Parameters (+5.0% TP, -2.5% SL)
  // Hard stop-loss: -2.5% (cuts losses early to preserve equity)
  if (pnlPct <= -2.5) {
    return { shouldClose: true, reason: `Stop-loss hit: ${pnlPct.toFixed(2)}% loss` };
  }

  // Take profit: +5.0% (rapid profit compounding for competition velocity)
  if (pnlPct >= 5.0) {
    return { shouldClose: true, reason: `Take-profit hit: ${pnlPct.toFixed(2)}% gain` };
  }

  // Trailing stop: if we are up >1.8% and signal reverses or drops back
  if (pnlPct >= 1.8) {
    // Check if signal reversed
    if (isLong && (analysis.signal === Signal.SELL || analysis.signal === Signal.STRONG_SELL)) {
      return { shouldClose: true, reason: `Trailing stop + bearish reversal at ${pnlPct.toFixed(2)}% gain` };
    }
    if (!isLong && (analysis.signal === Signal.BUY || analysis.signal === Signal.STRONG_BUY)) {
      return { shouldClose: true, reason: `Trailing stop + bullish reversal at ${pnlPct.toFixed(2)}% gain` };
    }
  }

  // Signal-based exit: strong contrary signal
  if (isLong && analysis.signal === Signal.STRONG_SELL) {
    return { shouldClose: true, reason: `Strong sell signal on long position` };
  }
  if (!isLong && analysis.signal === Signal.STRONG_BUY) {
    return { shouldClose: true, reason: `Strong buy signal on short position` };
  }

  // Deep emergency loss exit: -3.5%
  if (pnlPct <= -3.5) {
    return { shouldClose: true, reason: `Emergency stop-loss triggered at ${pnlPct.toFixed(2)}% loss` };
  }

  return { shouldClose: false, reason: `Holding: ${pnlPct.toFixed(2)}% PnL` };
}

module.exports = {
  Signal,
  SIGNAL_STRENGTH,
  analyzeAsset,
  rankOpportunities,
  shouldClosePosition,
};
