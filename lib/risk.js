/**
 * Risk Management v3 — Aggressive Volatility Allocation
 * 
 * PHILOSOPHY: Big position sizing on +25% volatility breakout mega-swings.
 * - Max 4 concurrent positions
 * - 20-30% allocation per trade (concentrated momentum bets)
 * - 35% max single asset cap
 * - Win-streak anti-martingale multiplier preserved
 */

// Risk Parameters (v3 Ultra-Volatility Competition Mode)
const CONFIG = {
  MAX_SINGLE_ASSET_EXPOSURE_PCT: 0.35, // Max 35% of total portfolio in 1 asset
  MAX_OPEN_POSITIONS: 4,               // Max 4 positions for concentrated breakout bets
  MIN_ORDER_USD: 200,                  // Min order $200
  DEFAULT_RISK_PER_TRADE_PCT: 0.20,    // 20% of equity per standard trade
  MAX_SPREAD_PCT: 0.04,                // Max 4% spread before skipping
};

/**
 * Calculate optimal position size in tokens for a given asset.
 * Includes Smart Compounding & Win-Streak Anti-Martingale Multiplier.
 */
function calculatePositionSize(portfolioComponent, signal, currentPrice, winStreakCount = 0) {
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

  const cash = Number(portfolioComponent.cash || portfolioComponent.availableBalance || 0);
  const positions = portfolioComponent.positions || portfolioComponent.components || [];
  
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

  // Check 1: Max open positions limit (max 4)
  const openCount = positions.filter(p => Math.abs(Number(p.quantity || p.tokenQuantity || 0)) > 0.01).length;
  if (openCount >= CONFIG.MAX_OPEN_POSITIONS) {
    result.reason = `Max open positions limit reached (${openCount}/${CONFIG.MAX_OPEN_POSITIONS})`;
    return result;
  }

  // Check 2: Signal conviction scaling (v3 Aggressive Allocation)
  let baseRiskFactor = CONFIG.DEFAULT_RISK_PER_TRADE_PCT; // 20%
  if (signal.strength === 5 || signal.strength === -5) {
    baseRiskFactor = 0.30; // 30% allocation on STRONG_BUY
  } else if (signal.strength === 3 || signal.strength === -3) {
    baseRiskFactor = 0.20; // 20% allocation on BUY
  } else {
    result.reason = 'Signal strength too weak for position entry';
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ══ SMART ANTI-MARTINGALE WIN-STREAK MULTIPLIER (KÂR KATLAMA MOTORU) ══
  // ══════════════════════════════════════════════════════════════════════
  let streakMultiplier = 1.0;
  if (winStreakCount === 1) streakMultiplier = 1.15;      // +15% boost on 1st win
  else if (winStreakCount === 2) streakMultiplier = 1.30; // +30% boost on 2nd win
  else if (winStreakCount >= 3) streakMultiplier = 1.45; // +45% MAX boost on 3+ win streak!

  const finalRiskFactor = Math.min(0.35, baseRiskFactor * streakMultiplier);

  // Desired compounding allocation in USD
  let targetUsd = totalValuation * finalRiskFactor;

  // Check 3: Max single asset cap (35% of total portfolio)
  const maxSingleAssetUsd = totalValuation * CONFIG.MAX_SINGLE_ASSET_EXPOSURE_PCT;
  
  const existingPos = positions.find(p => p.tokenName === signal.tokenName || p.propertyId === signal.propertyId);
  const existingVal = existingPos ? Math.abs(Number(existingPos.marketValue || existingPos.value || 0)) : 0;
  
  if (existingVal + targetUsd > maxSingleAssetUsd) {
    targetUsd = Math.max(0, maxSingleAssetUsd - existingVal);
  }

  // Check 4: Available cash check (%10 buffer)
  if (targetUsd > cash) {
    targetUsd = cash * 0.90;
  }

  // Check 5: Minimum order size
  if (targetUsd < CONFIG.MIN_ORDER_USD) {
    result.reason = `Position size ($${targetUsd.toFixed(2)}) below minimum ($${CONFIG.MIN_ORDER_USD})`;
    return result;
  }

  // Calculate quantity (Loaf accepts max 1 decimal place)
  const rawQuantity = targetUsd / currentPrice;
  const roundedQuantity = Math.floor(rawQuantity * 10) / 10;

  if (roundedQuantity <= 0) {
    result.reason = 'Calculated token quantity rounds to 0';
    return result;
  }

  result.quantity = roundedQuantity;
  result.allocationUsd = Math.round(roundedQuantity * currentPrice * 100) / 100;
  result.approved = true;
  result.reason = `Approved: $${result.allocationUsd} (${result.quantity} tokens) via ${signal.signal}`;

  return result;
}

/**
 * Validate market orderbook conditions before execution.
 */
function validateOrderBook(marketDetail) {
  const bids = marketDetail?.bids || marketDetail?.orderBook?.bids || [];
  const asks = marketDetail?.asks || marketDetail?.orderBook?.asks || [];

  if (!bids.length || !asks.length) {
    return { valid: false, spreadPct: 0, reason: 'Empty order book' };
  }

  const bestBid = Number(bids[0].price || bids[0][0]);
  const bestAsk = Number(asks[0].price || asks[0][0]);

  if (bestBid <= 0 || bestAsk <= 0 || bestAsk <= bestBid) {
    return { valid: false, spreadPct: 0, reason: `Invalid prices: Bid ${bestBid}, Ask ${bestAsk}` };
  }

  const spread = bestAsk - bestBid;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadPct = spread / midPrice;

  if (spreadPct > CONFIG.MAX_SPREAD_PCT) {
    return {
      valid: false,
      spreadPct: Math.round(spreadPct * 10000) / 100,
      reason: `Spread too wide: ${(spreadPct * 100).toFixed(2)}%`,
    };
  }

  return {
    valid: true,
    spreadPct: Math.round(spreadPct * 10000) / 100,
    bestBid,
    bestAsk,
    midPrice,
    reason: 'Order book verified',
  };
}

module.exports = {
  CONFIG,
  calculatePositionSize,
  validateOrderBook,
};
