/**
 * Risk Management & Position Sizing Engine
 * 
 * Enforces strict risk rules for the Loaf Markets testnet competition:
 * - Max position size per asset (% of total portfolio)
 * - Max open positions count
 * - Dynamic order sizing based on account balance & asset volatility
 * - Slippage & Spread sanity checks
 */

// Risk Parameters (Aggressive Competition Mode)
const CONFIG = {
  MAX_SINGLE_ASSET_EXPOSURE_PCT: 0.30, // Max 30% of total portfolio in 1 asset
  MAX_OPEN_POSITIONS: 8,               // Max 8 concurrent positions for high capital utilization
  MIN_ORDER_USD: 100,                  // Min order size to avoid dust orders
  DEFAULT_RISK_PER_TRADE_PCT: 0.06,    // Risk 6% of total equity per standard trade
  MAX_SPREAD_PCT: 0.04,                // Max allowable spread (4%) before skipping trade
};

/**
 * Calculate optimal position size in tokens for a given asset.
 * 
 * @param {Object} portfolioComponent - Output from getPortfolioComponent()
 * @param {Object} signal - Output from analyzeAsset()
 * @param {number} currentPrice
 * @returns {{ quantity: number, allocationUsd: number, approved: boolean, reason: string }}
 */
function calculatePositionSize(portfolioComponent, signal, currentPrice) {
  const result = {
    quantity: 0,
    allocationUsd: 0,
    approved: false,
    reason: '',
  };

  if (!currentPrice || currentPrice <= 0) {
    result.reason = 'Invalid current price';
    return result;
  }

  // Extract portfolio cash & total valuation
  // Portfolio component structure has `cash` and `positions` or `components`
  const cash = Number(portfolioComponent.cash || portfolioComponent.availableBalance || 0);
  const positions = portfolioComponent.positions || portfolioComponent.components || [];
  
  // Calculate total portfolio value (cash + positions value)
  let positionsValue = 0;
  for (const pos of positions) {
    const val = Number(pos.marketValue || pos.value || (pos.quantity * pos.currentPrice) || 0);
    positionsValue += val;
  }
  const totalValuation = cash + positionsValue;

  if (totalValuation <= 0) {
    result.reason = 'Portfolio valuation zero or unavailable';
    return result;
  }

  // Check 1: Max open positions limit
  const openCount = positions.filter(p => Math.abs(Number(p.quantity || p.tokenQuantity || 0)) > 0.01).length;
  if (openCount >= CONFIG.MAX_OPEN_POSITIONS) {
    result.reason = `Max open positions limit reached (${openCount}/${CONFIG.MAX_OPEN_POSITIONS})`;
    return result;
  }

  // Check 2: Aggressive Signal conviction scaling
  let riskFactor = CONFIG.DEFAULT_RISK_PER_TRADE_PCT;
  if (signal.strength === 5 || signal.strength === -5) {
    riskFactor = 0.12; // 12% allocation on STRONG high-conviction signals
  } else if (signal.strength === 3 || signal.strength === -3) {
    riskFactor = 0.06; // 6% allocation on standard BUY/SELL
  } else {
    result.reason = 'Signal strength too weak for position entry';
    return result;
  }

  // Desired allocation in USD
  let targetUsd = totalValuation * riskFactor;

  // Check 3: Max single asset cap (25% of total portfolio)
  const maxSingleAssetUsd = totalValuation * CONFIG.MAX_SINGLE_ASSET_EXPOSURE_PCT;
  
  // Existing position in this asset?
  const existingPos = positions.find(p => p.tokenName === signal.tokenName || p.propertyId === signal.propertyId);
  const existingVal = existingPos ? Math.abs(Number(existingPos.marketValue || existingPos.value || 0)) : 0;
  
  if (existingVal + targetUsd > maxSingleAssetUsd) {
    targetUsd = Math.max(0, maxSingleAssetUsd - existingVal);
  }

  // Check 4: Available cash check
  if (targetUsd > cash) {
    targetUsd = cash * 0.95; // Leave 5% buffer
  }

  // Check 5: Minimum order size
  if (targetUsd < CONFIG.MIN_ORDER_USD) {
    result.reason = `Calculated position size ($${targetUsd.toFixed(2)}) below minimum threshold ($${CONFIG.MIN_ORDER_USD})`;
    return result;
  }

  // Calculate quantity (Loaf accepts max 1 decimal place for quantity)
  const rawQuantity = targetUsd / currentPrice;
  const roundedQuantity = Math.floor(rawQuantity * 10) / 10;

  if (roundedQuantity <= 0) {
    result.reason = 'Calculated token quantity rounds to 0';
    return result;
  }

  result.quantity = roundedQuantity;
  result.allocationUsd = Math.round(roundedQuantity * currentPrice * 100) / 100;
  result.approved = true;
  result.reason = `Approved entry: $${result.allocationUsd} (${result.quantity} tokens) based on ${signal.signal}`;

  return result;
}

/**
 * Validate market orderbook conditions before execution.
 * Prevents buying into illiquid/manipulated books or huge spreads.
 * 
 * @param {Object} marketDetail - Output from getMarketDetail()
 * @returns {{ valid: boolean, spreadPct: number, reason: string }}
 */
function validateOrderBook(marketDetail) {
  const bids = marketDetail?.bids || marketDetail?.orderBook?.bids || [];
  const asks = marketDetail?.asks || marketDetail?.orderBook?.asks || [];

  if (!bids.length || !asks.length) {
    return { valid: false, spreadPct: 0, reason: 'Empty order book (no bids or asks)' };
  }

  const bestBid = Number(bids[0].price || bids[0][0]);
  const bestAsk = Number(asks[0].price || asks[0][0]);

  if (bestBid <= 0 || bestAsk <= 0 || bestAsk <= bestBid) {
    return { valid: false, spreadPct: 0, reason: `Invalid order book prices: Bid ${bestBid}, Ask ${bestAsk}` };
  }

  const spread = bestAsk - bestBid;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadPct = spread / midPrice;

  if (spreadPct > CONFIG.MAX_SPREAD_PCT) {
    return {
      valid: false,
      spreadPct: Math.round(spreadPct * 10000) / 100,
      reason: `Spread too wide: ${(spreadPct * 100).toFixed(2)}% (Max allowed: ${(CONFIG.MAX_SPREAD_PCT * 100).toFixed(2)}%)`,
    };
  }

  return {
    valid: true,
    spreadPct: Math.round(spreadPct * 10000) / 100,
    bestBid,
    bestAsk,
    midPrice,
    reason: 'Order book liquidity verified',
  };
}

module.exports = {
  CONFIG,
  calculatePositionSize,
  validateOrderBook,
};
