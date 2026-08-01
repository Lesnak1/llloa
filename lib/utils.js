/**
 * Utility functions for logging, time formatting, and response shaping.
 */

function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

function formatPct(val) {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const output = { timestamp, level, message, ...meta };
  console.log(JSON.stringify(output));
}

module.exports = {
  formatCurrency,
  formatPct,
  log,
};
