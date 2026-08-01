/**
 * Vercel Serverless Function — Main Bot Loop
 * 
 * Executed periodically (via Cron or HTTP call).
 * Flow:
 *  1. Authenticate secret token
 *  2. Fetch portfolio & current positions
 *  3. Scan all tradeable properties on Loaf Markets
 *  4. Manage existing open positions (Stop-loss / Take-profit / Trailing Stop)
 *  5. Evaluate new trading opportunities using technical analysis (RSI, EMA, MACD, Volume)
 *  6. Apply strict Risk Management & place orders
 *  7. Return comprehensive execution summary
 */

const { LoafClient } = require('../lib/loaf-client');
const { analyzeAsset, rankOpportunities, shouldClosePosition, Signal } = require('../lib/strategy');
const { calculatePositionSize, validateOrderBook } = require('../lib/risk');
const { formatCurrency, formatPct, log } = require('../lib/utils');

// ── Stop-Loss Cooldown Tracker (prevents re-entry after recent stop-out) ──
// Key: tokenName, Value: timestamp of last stop-loss exit
// Persisted across ticks via global scope in Vercel serverless (warm starts)
const stopLossCooldowns = global.__stopLossCooldowns || (global.__stopLossCooldowns = {});
const COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes cooldown after stop-loss

module.exports = async function handler(req, res) {
  const startTime = Date.now();
  const logs = [];

  const addLog = (msg, meta = {}) => {
    logs.push({ time: new Date().toISOString(), msg, ...meta });
    log('INFO', msg, meta);
  };

  try {
    // ── 1. Security Check ──
    const secret = req.query?.secret || req.headers?.['x-bot-secret'];
    const expectedSecret = process.env.BOT_SECRET;

    if (expectedSecret && secret !== expectedSecret) {
      log('WARN', 'Unauthorized access attempt to bot endpoint');
      return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
    }

    addLog('🚀 Starting Loaf Markets Expert Algorithmic Trading Loop');

    // ── 2. Initialize Loaf Client ──
    const apiKey = process.env.LOAF_API_KEY;
    if (!apiKey) {
      throw new Error('LOAF_API_KEY environment variable is not configured');
    }
    const client = new LoafClient({ apiKey });

    // ── 3. Fetch Portfolio State & Full Account Audit ──
    addLog('Fetching portfolio & account state...');
    const portfolioComp = await client.getPortfolioComponent();
    const cash = Number(portfolioComp.cash || portfolioComp.availableBalance || 0);
    const frozen = Number(portfolioComp.frozen || 0);
    const positions = portfolioComp.positions || portfolioComp.components || [];
    const openOrders = portfolioComp.openOrders || [];
    const offeringOrders = portfolioComp.offeringOrders || [];

    addLog(`Portfolio retrieved`, {
      cash: formatCurrency(cash),
      frozen: formatCurrency(frozen),
      openPositionsCount: positions.length,
      openOrdersCount: openOrders.length,
      offeringOrdersCount: offeringOrders.length,
    });

    // ── 3b. Open Orders Management (Cancel Stale Orders to Unfreeze Cash) ──
    if (openOrders.length > 0) {
      addLog(`Auditing ${openOrders.length} Open Orders (unfreezing stale liquidity)...`);
      for (const order of openOrders) {
        const orderId = order.orderId || order.id;
        const tokenName = order.tokenName || order.symbol;
        const price = Number(order.price || 0);
        
        // Fetch current market detail to check if open order is far from best bid/ask
        try {
          if (tokenName) {
            const detail = await client.getMarketDetail(tokenName);
            const bids = detail?.bids || detail?.orderBook?.bids || [];
            const asks = detail?.asks || detail?.orderBook?.asks || [];
            const bestBid = bids.length ? Number(bids[0].price || bids[0][0]) : 0;
            const bestAsk = asks.length ? Number(asks[0].price || asks[0][0]) : 0;

            // If order price is >3% away from current market, cancel it to unfreeze cash
            const isFar = order.side === 'BUY'
              ? (bestAsk > 0 && (bestAsk - price) / bestAsk > 0.03)
              : (bestBid > 0 && (price - bestBid) / price > 0.03);

            if (isFar) {
              addLog(`Cancelling stale order #${orderId} on ${tokenName} (Price $${price} is far from market $${bestAsk || bestBid})`);
              await client.cancelOrder(orderId);
              addLog(`✅ Order #${orderId} cancelled. Cash unfrozen!`);
            }
          }
        } catch (ordErr) {
          addLog(`Note on open order #${orderId}: ${ordErr.message}`);
        }
      }
    }

    // ── 4. Scan Markets ──
    addLog('Fetching tradeable markets list...');
    const marketsData = await client.getMarkets();
    const properties = Array.isArray(marketsData) ? marketsData : (marketsData.properties || marketsData.items || []);

    if (!properties.length) {
      addLog('No properties returned from API. Halting tick.');
      return res.status(200).json({ success: true, message: 'No markets available', durationMs: Date.now() - startTime });
    }

    addLog(`Discovered ${properties.length} tradeable properties. Beginning TA analysis...`);

    // ── 5. Market Data Analysis & Strategy Signals ──
    const marketAnalyses = [];
    
    for (const prop of properties) {
      const tokenName = prop.tokenName || prop.symbol || prop.name;
      const propertyId = prop.propertyId || prop.id;

      try {
        // Fetch 15m candles (last 100 candles = ~25 hours of high-resolution data)
        const candleRes = await client.getCandles(tokenName, '15m', 100);
        const candles = candleRes.candles || candleRes.items || candleRes || [];

        if (candles.length > 0) {
          const analysis = analyzeAsset(candles, tokenName);
          analysis.propertyId = propertyId;
          marketAnalyses.push(analysis);
        }
      } catch (err) {
        addLog(`Error fetching candles for ${tokenName}: ${err.message}`);
      }
    }

    // ── 6. Manage Open Positions (Exits / Stop-Loss / Take-Profit) ──
    addLog('Evaluating open positions for exit signals...');
    const closedPositionsSummary = [];

    for (const pos of positions) {
      const tokenName = pos.tokenName || pos.symbol;
      const qty = Number(pos.quantity || pos.tokenQuantity || 0);
      if (Math.abs(qty) < 0.01) continue; // Skip zero positions

      const matchingAnalysis = marketAnalyses.find(a => a.tokenName === tokenName) || {
        currentPrice: Number(pos.currentPrice || pos.markPrice || 0),
        signal: Signal.HOLD
      };

      const currentPrice = matchingAnalysis.currentPrice || Number(pos.currentPrice || 0);
      const exitEvaluation = shouldClosePosition(pos, currentPrice, matchingAnalysis);

      if (exitEvaluation.shouldClose) {
        addLog(`⚠️ Exit Triggered for ${tokenName}: ${exitEvaluation.reason}`);
        
        try {
          let exitRes;
          const propId = pos.propertyId || matchingAnalysis.propertyId;

          // Fetch orderbook detail to place slippage-protected limit exit order
          const exitDetail = await client.getMarketDetail(tokenName);
          const bids = exitDetail?.bids || exitDetail?.orderBook?.bids || [];
          const asks = exitDetail?.asks || exitDetail?.orderBook?.asks || [];
          const bestBid = bids.length ? Number(bids[0].price || bids[0][0]) : currentPrice;
          const bestAsk = asks.length ? Number(asks[0].price || asks[0][0]) : currentPrice;

          // ── FLASH CRASH SELL-PRICE FLOOR ──
          // Enforce minimum sell price from strategy (entry * 0.92)
          // This prevents catastrophic fills during flash crashes
          const minSellPrice = exitEvaluation.minSellPrice || 0;

          if (qty > 0) {
            // Close LONG -> Limit Sell at MAX(bestBid, minSellPrice)
            const safeSellPrice = Math.max(bestBid || currentPrice, minSellPrice);
            addLog(`Flash crash floor: bestBid=$${bestBid}, minSellPrice=$${minSellPrice}, using=$${safeSellPrice}`);
            exitRes = await client.limitSell(propId, tokenName, Math.abs(qty), safeSellPrice);
          } else {
            // Close SHORT -> Limit Buy at bestAsk
            exitRes = await client.limitBuy(propId, tokenName, Math.abs(qty), bestAsk || currentPrice);
          }

          // Record stop-loss cooldown to prevent immediate re-entry
          if (exitEvaluation.reason.includes('Stop-loss') || exitEvaluation.reason.includes('stop-loss')) {
            stopLossCooldowns[tokenName] = Date.now();
            addLog(`🛡️ Cooldown activated for ${tokenName}: no re-entry for 30 minutes`);
          }

          closedPositionsSummary.push({
            tokenName,
            quantity: Math.abs(qty),
            reason: exitEvaluation.reason,
            orderId: exitRes?.orderId || exitRes?.id || 'OK'
          });

          addLog(`✅ Successfully closed position in ${tokenName}`);
        } catch (exitErr) {
          addLog(`❌ Failed to close position ${tokenName}: ${exitErr.message}`);
        }
      } else {
        addLog(`Holding position in ${tokenName}: ${exitEvaluation.reason}`);
      }
    }

    // ── 7. Evaluate & Execute New Position Entries ──
    addLog('Ranking new trade opportunities...');
    const rankedOpportunities = rankOpportunities(marketAnalyses);
    const executedTradesSummary = [];

    for (const opp of rankedOpportunities) {
      // Only process actionable signals (BUY / STRONG_BUY)
      if (opp.signal !== Signal.BUY && opp.signal !== Signal.STRONG_BUY) continue;

      // Check if we already hold this token
      const existing = positions.find(p => p.tokenName === opp.tokenName && Math.abs(Number(p.quantity || 0)) > 0.01);
      if (existing) {
        addLog(`Skipping new entry for ${opp.tokenName}: Position already open.`);
        continue;
      }

      // Check stop-loss cooldown (prevent re-entry after recent stop-out)
      const lastStopTime = stopLossCooldowns[opp.tokenName] || 0;
      if (Date.now() - lastStopTime < COOLDOWN_MS) {
        const minutesLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastStopTime)) / 60000);
        addLog(`🛡️ Skipping ${opp.tokenName}: Stop-loss cooldown active (${minutesLeft}min remaining)`);
        continue;
      }

      // Check orderbook liquidity & spread
      try {
        const detail = await client.getMarketDetail(opp.tokenName);
        const obValidation = validateOrderBook(detail);

        if (!obValidation.valid) {
          addLog(`Skipping ${opp.tokenName}: ${obValidation.reason}`);
          continue;
        }

        // Calculate risk-adjusted position size
        const posSizing = calculatePositionSize(portfolioComp, opp, obValidation.midPrice);

        if (!posSizing.approved) {
          addLog(`Risk Manager declined ${opp.tokenName}: ${posSizing.reason}`);
          continue;
        }

        addLog(`⚡ EXECUTING ENTRY: ${opp.signal} on ${opp.tokenName}`, {
          quantity: posSizing.quantity,
          allocationUsd: posSizing.allocationUsd,
          price: obValidation.bestAsk
        });

        // Place Order (Always use Limit Order at bestAsk to eliminate orderbook spread slippage)
        let orderRes = await client.limitBuy(opp.propertyId, opp.tokenName, posSizing.quantity, obValidation.bestAsk);

        executedTradesSummary.push({
          tokenName: opp.tokenName,
          signal: opp.signal,
          quantity: posSizing.quantity,
          price: obValidation.bestAsk,
          allocationUsd: posSizing.allocationUsd,
          orderId: orderRes?.orderId || orderRes?.id || 'ACCEPTED',
          reason: opp.reason
        });

        addLog(`🎉 Order Accepted for ${opp.tokenName}! Order ID: ${orderRes?.orderId || 'ACCEPTED'}`);

      } catch (tradeErr) {
        addLog(`❌ Execution Error on ${opp.tokenName}: ${tradeErr.message}`);
      }
    }

    // ── 8. Return Execution Summary Response ──
    const durationMs = Date.now() - startTime;
    addLog(`🏁 Trading loop completed in ${durationMs}ms`);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      durationMs,
      portfolioState: {
        cash: formatCurrency(cash),
        openPositions: positions.length,
      },
      marketSummary: {
        totalScanned: properties.length,
        analyzed: marketAnalyses.length,
        actionableSignals: rankedOpportunities.length
      },
      actionsTaken: {
        closedPositions: closedPositionsSummary,
        newTradesPlaced: executedTradesSummary
      },
      logs
    });

  } catch (error) {
    log('ERROR', 'Fatal bot execution error', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      error: error.message,
      durationMs: Date.now() - startTime,
      logs
    });
  }
};
