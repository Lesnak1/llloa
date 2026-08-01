/**
 * Technical Analysis Indicators — Zero Dependencies
 * 
 * All functions work with plain arrays of numbers.
 * Designed for the Loaf Markets candle data format:
 *   { time, open, high, low, close, volume }
 */

/**
 * Simple Moving Average
 * @param {number[]} data
 * @param {number} period
 * @returns {number[]} SMA values (length = data.length, first period-1 are NaN)
 */
function calculateSMA(data, period) {
  const result = new Array(data.length).fill(NaN);
  if (data.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    sum += data[i] - data[i - period];
    result[i] = sum / period;
  }
  return result;
}

/**
 * Exponential Moving Average
 * @param {number[]} data
 * @param {number} period
 * @returns {number[]} EMA values
 */
function calculateEMA(data, period) {
  const result = new Array(data.length).fill(NaN);
  if (data.length < period) return result;

  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  result[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Relative Strength Index
 * @param {number[]} closes
 * @param {number} [period=14]
 * @returns {number[]} RSI values (0-100)
 */
function calculateRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/**
 * MACD (12, 26, 9)
 * @param {number[]} closes
 * @returns {{ macd: number[], signal: number[], histogram: number[] }}
 */
function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  const macdLine = closes.map((_, i) =>
    isNaN(ema12[i]) || isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]
  );

  // Signal line: EMA(9) of MACD line — filter out NaN first
  const validStart = macdLine.findIndex((v) => !isNaN(v));
  const validMacd = validStart >= 0 ? macdLine.slice(validStart) : [];
  const signalRaw = calculateEMA(validMacd, 9);

  const signal = new Array(closes.length).fill(NaN);
  for (let i = 0; i < signalRaw.length; i++) {
    signal[validStart + i] = signalRaw[i];
  }

  const histogram = closes.map((_, i) =>
    isNaN(macdLine[i]) || isNaN(signal[i]) ? NaN : macdLine[i] - signal[i]
  );

  return { macd: macdLine, signal, histogram };
}

/**
 * Bollinger Bands (20, 2σ)
 * @param {number[]} closes
 * @param {number} [period=20]
 * @param {number} [stdDev=2]
 * @returns {{ upper: number[], middle: number[], lower: number[] }}
 */
function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  const middle = calculateSMA(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - middle[i];
      sumSq += diff * diff;
    }
    const sd = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + stdDev * sd;
    lower[i] = middle[i] - stdDev * sd;
  }

  return { upper, middle, lower };
}

/**
 * Average True Range (volatility)
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} [period=14]
 * @returns {number[]} ATR values
 */
function calculateATR(highs, lows, closes, period = 14) {
  const len = closes.length;
  const tr = new Array(len).fill(NaN);
  const result = new Array(len).fill(NaN);

  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < len; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  // First ATR is SMA of first `period` TRs
  let sum = 0;
  for (let i = 0; i < period && i < len; i++) sum += tr[i];
  if (len >= period) result[period - 1] = sum / period;

  for (let i = period; i < len; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }

  return result;
}

/**
 * Volume trend analysis: compare recent volume to its average.
 * @param {number[]} volumes
 * @param {number} [shortPeriod=5]
 * @param {number} [longPeriod=20]
 * @returns {{ ratio: number, trend: 'spike'|'high'|'normal'|'low' }}
 */
function analyzeVolume(volumes, shortPeriod = 5, longPeriod = 20) {
  if (volumes.length < longPeriod) {
    return { ratio: 1, trend: 'normal' };
  }

  const recent = volumes.slice(-shortPeriod);
  const all = volumes.slice(-longPeriod);

  const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgAll = all.reduce((a, b) => a + b, 0) / all.length;

  const ratio = avgAll > 0 ? avgRecent / avgAll : 1;

  let trend = 'normal';
  if (ratio > 2.0) trend = 'spike';
  else if (ratio > 1.3) trend = 'high';
  else if (ratio < 0.5) trend = 'low';

  return { ratio, trend };
}

/**
 * Calculate momentum (rate of change over N periods)
 * @param {number[]} closes
 * @param {number} [period=10]
 * @returns {number} percentage change
 */
function calculateMomentum(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return past !== 0 ? ((current - past) / past) * 100 : 0;
}

/**
 * Get the latest non-NaN value from an indicator array.
 * @param {number[]} arr
 * @returns {number|null}
 */
function latest(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!isNaN(arr[i])) return arr[i];
  }
  return null;
}

module.exports = {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  analyzeVolume,
  calculateMomentum,
  latest,
};
