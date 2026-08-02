/**
 * Trading Strategy v2 — High-Conviction Trend Following
 * 
 * PHILOSOPHY: Trade LESS, trade BIGGER, trade BETTER.
 * - Anti-chop filter: reject signals in sideways/choppy markets
 * - Trend confirmation: require multiple aligned indicators before entry
 * - Asymmetric TP/SL: +10% TP / -3% SL = 3.33:1 reward-to-risk
 * - Trailing profit-lock: secure gains at +4% on any weakness
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
  const bbM = latest(bbMiddle) ?? currentPrice;
  const atr = latest(atrArr) ?? currentPrice * 0.02;

  result.rsi = Math.round(rsi * 100) / 100;
  result.ema9 = Math.round(e9 * 100) / 100;
  result.ema21 = Math.round(e21 * 100) / 100;
  result.atr = Math.round(atr * 100) / 100;
  result.volumeTrend = volAnalysis.trend;
  result.momentum = Math.round(momentum * 100) / 100;

  // ── Multi-Timeframe Alignment (1H Macro Trend from 15m candles) ──
  const emaMacroShort = calculateEMA(closes, 36);
  const emaMacroLong = calculateEMA(closes, 84);
  const eMacroShort = latest(emaMacroShort) ?? currentPrice;
  const eMacroLong = latest(emaMacroLong) ?? currentPrice;
  const isMacroBullish = eMacroShort > eMacroLong;
  const isMacroBearish = eMacroShort < eMacroLong;

  // ══════════════════════════════════════════════════════════════
  // ══ ANTI-CHOP FILTER — Reject signals in sideways markets ══
  // ══════════════════════════════════════════════════════════════
  
  const recentCloses = closes.slice(-4);
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let i = 1; i < recentCloses.length; i++) {
    if (recentCloses[i] > recentCloses[i-1]) consecutiveUp++;
    else if (recentCloses[i] < recentCloses[i-1]) consecutiveDown++;
  }
  const isTrending = consecutiveUp >= 3 || consecutiveDown >= 3;
  
  const bbWidth = bbU > 0 && bbL > 0 ? ((bbU - bbL) / bbM) * 100 : 0;
  const isChoppy = bbWidth < 2.0;
  
  if (isChoppy && !isTrending) {
    result.signal = Signal.HOLD;
    result.strength = 0;
    result.score = 0;
    result.reason = 'ANTI-CHOP: Market choppy (BB width ' + bbWidth.toFixed(1) + '%), no clear trend';
    return result;
  }

  // ── Scoring system ──
  let score = 0;
  const reasons = [];

  if (isMacroBullish) { score += 15; reasons.push('1H Macro Bullish'); }
  else if (isMacroBearish) { score -= 15; reasons.push('1H Macro Bearish'); }

  if (rsi < 25) { score += 25; reasons.push(`RSI deeply oversold (${rsi.toFixed(1)})`); }
  else if (rsi < 30) { score += 18; reasons.push(`RSI oversold (${rsi.toFixed(1)})`); }
  else if (rsi > 75) { score -= 25; reasons.push(`RSI deeply overbought (${rsi.toFixed(1)})`); }
  else if (rsi > 70) { score -= 18; reasons.push(`RSI overbought (${rsi.toFixed(1)})`); }

  if (e9 > e21) { score += 15; reasons.push('EMA9 > EMA21 (bullish)'); }
  else if (e9 < e21) { score -= 15; reasons.push('EMA9 < EMA21 (bearish)'); }

  if (ema9.length >= 3 && ema21.length >= 3) {
    const prev9 = ema9[ema9.length - 3];
    const prev21 = ema21[ema21.length - 3];
    if (!isNaN(prev9) && !isNaN(prev21)) {
      if (prev9 <= prev21 && e9 > e21) { score += 12; reasons.push('Fresh bullish EMA cross'); }
      else if (prev9 >= prev21 && e9 < e21) { score -= 12; reasons.push('Fresh bearish EMA cross'); }
    }
  }

  if (macdHist > 0 && macdVal > macdSignal) { score += 10; reasons.push('MACD bullish'); }
  else if (macdHist < 0 && macdVal < macdSignal) { score -= 10; reasons.push('MACD bearish'); }

  if (currentPrice < bbL) { score += 20; reasons.push('Price below lower BB'); }
  else if (currentPrice > bbU) { score -= 20; reasons.push('Price above upper BB'); }

  if (momentum > 4) { score += 12; reasons.push(`Strong momentum (${momentum.toFixed(1)}%)`); }
  else if (momentum > 2) { score += 6; reasons.push(`Positive momentum (${momentum.toFixed(1)}%)`); }
  else if (momentum < -4) { score -= 12; reasons.push(`Strong neg momentum (${momentum.toFixed(1)}%)`); }
  else if (momentum < -2) { score -= 6; reasons.push(`Neg momentum (${momentum.toFixed(1)}%)`); }

  if (consecutiveUp >= 3) { score += 10; reasons.push('3+ green candles'); }
  else if (consecutiveDown >= 3) { score -= 10; reasons.push('3+ red candles'); }

  if (volAnalysis.trend === 'spike') {
    score *= 1.3;
    reasons.push('Volume spike');
  } else if (volAnalysis.trend === 'high') {
    score *= 1.1;
    reasons.push('High volume');
  } else if (volAnalysis.trend === 'low') {
    score *= 0.5;
    reasons.push('Low volume — unreliable');
  }

  // ══════════════════════════════════════════════════════════════
  // ══ ASSET-SPECIFIC VOLATILITY OPTIMIZER (MetLife Dip-Sniper) ══
  // ══════════════════════════════════════════════════════════════
  // For high-volatility assets like metlife, require deep oversold confirmation (RSI < 35 or Lower BB touch)
  // before approving BUY signals, avoiding premature entries at fake tops.
  const isHighVolToken = tokenName && tokenName.toLowerCase() === 'metlife';
  if (isHighVolToken) {
    const isDeepOversold = rsi < 35 || currentPrice <= bbL;
    if (!isDeepOversold && score < 60) {
      score *= 0.6; // Dampen score unless deeply oversold or huge institutional volume breakout
      reasons.push('MetLife Dip Optimizer: Awaiting deep oversold confirmation (RSI < 35 or BB touch)');
    } else if (isDeepOversold) {
      score += 15; // Bonus for catching true MetLife deep dips!
      reasons.push('MetLife Dip Optimizer: Deep oversold dip confirmed!');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ══ HIGH-CONVICTION SIGNAL MAPPING (strict thresholds)     ══
  // ══════════════════════════════════════════════════════════════
  let signal, strength;

  if (score >= 50) {
    signal = Signal.STRONG_BUY;
    strength = 5;
  } else if (score >= 35) {
    signal = Signal.BUY;
    strength = 3;
  } else if (score <= -50) {
    signal = Signal.STRONG_SELL;
    strength = -5;
  } else if (score <= -35) {
    signal = Signal.SELL;
    strength = -3;
  } else {
    signal = Signal.HOLD;
    strength = 0;
  }

  const entryPrice = signal === Signal.BUY || signal === Signal.STRONG_BUY
    ? currentPrice
    : signal === Signal.SELL || signal === Signal.STRONG_SELL
      ? currentPrice
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

function rankOpportunities(analyses) {
  const actionable = analyses.filter((a) => a.signal !== Signal.HOLD);
  return actionable.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

/* ──────── Check if existing position should be closed ──────── */

function shouldClosePosition(position, currentPrice, analysis) {
  const entry = Number(position.averageEntryPrice || position.avgEntryPrice || position.averagePrice || 0);
  const qty = Number(position.quantity || position.tokenQuantity || 0);
  if (!entry || !qty) return { shouldClose: false, reason: 'No valid position data' };

  const isLong = qty > 0;
  const pnlPct = isLong
    ? ((currentPrice - entry) / entry) * 100
    : ((entry - currentPrice) / entry) * 100;

  // ── Hard Stop-Loss: -3.0% (tight, asymmetric with +10% TP = 3.33:1 RR) ──
  if (pnlPct <= -3.0) {
    return { shouldClose: true, reason: `Stop-loss hit: ${pnlPct.toFixed(2)}% loss` };
  }

  // ── Take Profit: +10.0% (let winners run) ──
  if (pnlPct >= 10.0) {
    return { shouldClose: true, reason: `Take-profit hit: ${pnlPct.toFixed(2)}% gain` };
  }

  // ── Trailing Profit-Lock at +4.0% on any weakness ──
  if (pnlPct >= 4.0) {
    if (isLong && (analysis.signal === Signal.SELL || analysis.signal === Signal.STRONG_SELL || analysis.signal === Signal.HOLD)) {
      return { shouldClose: true, reason: `Profit-lock at ${pnlPct.toFixed(2)}% (signal: ${analysis.signal})` };
    }
    if (!isLong && (analysis.signal === Signal.BUY || analysis.signal === Signal.STRONG_BUY || analysis.signal === Signal.HOLD)) {
      return { shouldClose: true, reason: `Profit-lock at ${pnlPct.toFixed(2)}% (signal: ${analysis.signal})` };
    }
  }

  // ── At +2.5%: exit on strong contrary signal ──
  if (pnlPct >= 2.5) {
    if (isLong && (analysis.signal === Signal.SELL || analysis.signal === Signal.STRONG_SELL)) {
      return { shouldClose: true, reason: `Trailing stop + reversal at ${pnlPct.toFixed(2)}%` };
    }
    if (!isLong && (analysis.signal === Signal.BUY || analysis.signal === Signal.STRONG_BUY)) {
      return { shouldClose: true, reason: `Trailing stop + reversal at ${pnlPct.toFixed(2)}%` };
    }
  }

  // ── Signal-Based Exit: strong contrary at any PnL ──
  if (isLong && analysis.signal === Signal.STRONG_SELL) {
    return { shouldClose: true, reason: `Strong sell signal on long position` };
  }
  if (!isLong && analysis.signal === Signal.STRONG_BUY) {
    return { shouldClose: true, reason: `Strong buy signal on short position` };
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
