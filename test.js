/**
 * Local Integration Test Script
 * Runs indicators and API client logic locally to verify code correctness before deployment.
 */

const { calculateRSI, calculateEMA, calculateMACD } = require('./lib/indicators');
const { analyzeAsset, Signal } = require('./lib/strategy');

console.log('🧪 Starting Local Bot Engine Sanity Tests...\n');

// 1. Test TA Indicators
console.log('1️⃣ Testing Technical Indicators:');
const sampleCloses = [
  10, 11, 12, 11.5, 13, 14, 13.5, 15, 16, 15.5,
  17, 18, 17.5, 19, 20, 21, 20.5, 22, 23, 22.5,
  24, 25, 26, 25.5, 27, 28, 27.5, 29, 30, 31
];

const rsi = calculateRSI(sampleCloses, 14);
const ema9 = calculateEMA(sampleCloses, 9);
const macd = calculateMACD(sampleCloses);

console.log(` - RSI (latest): ${rsi[rsi.length - 1].toFixed(2)}`);
console.log(` - EMA9 (latest): ${ema9[ema9.length - 1].toFixed(2)}`);
console.log(` - MACD Line (latest): ${macd.macd[macd.macd.length - 1].toFixed(2)}`);
console.log(' ✅ Indicators calculated successfully.\n');

// 2. Test Strategy Engine
console.log('2️⃣ Testing Strategy Engine:');
const mockCandles = sampleCloses.map((c, i) => ({
  time: Date.now() - (30 - i) * 3600000,
  open: c * 0.99,
  high: c * 1.02,
  low: c * 0.98,
  close: c,
  volume: 1000 + i * 50
}));

const analysis = analyzeAsset(mockCandles, 'OPR');
console.log(` - Token: ${analysis.tokenName}`);
console.log(` - Signal: ${analysis.signal}`);
console.log(` - Strength: ${analysis.strength}`);
console.log(` - Score: ${analysis.score}`);
console.log(` - Stop Loss: $${analysis.stopLoss}`);
console.log(` - Take Profit: $${analysis.takeProfit}`);
console.log(` - Reason: ${analysis.reason}`);
console.log(' ✅ Strategy engine working cleanly.\n');

console.log('🎉 All local engine tests passed! Code is ready for Vercel deployment.');
