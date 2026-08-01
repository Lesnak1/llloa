/**
 * Loaf Markets REST API Client
 * 
 * Complete wrapper for the Loaf trading API with nonce-based order flow.
 * Zero external dependencies — uses native fetch (Node 18+ / Vercel runtime).
 */

const DEFAULT_BASE = 'https://api.loafmarkets.com';

class LoafClient {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey  - 64-char hex API key
   * @param {string} [opts.base] - API base URL (no trailing slash)
   */
  constructor({ apiKey, base } = {}) {
    this.apiKey = apiKey || process.env.LOAF_API_KEY;
    this.base = (base || process.env.LOAF_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    if (!this.apiKey) throw new Error('LOAF_API_KEY is required');
  }

  /* ───────────────────── internal helpers ───────────────────── */

  /** @private */
  _headers(auth = false) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  /** @private */
  async _request(method, path, { body, auth = false, params } = {}) {
    let url = `${this.base}${path}`;
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const opts = { method, headers: this._headers(auth) };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();

    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) {
      const msg = data?.message || data?.error || text || res.statusText;
      const err = new Error(`Loaf API ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  /* ───────────────── Market Data (public, no auth) ──────────── */

  /** List all tradeable properties with sparkline & market data. */
  async getMarkets() {
    return this._request('GET', '/api/trade');
  }

  /** Full market detail for one property: order book, recent trades, session stats. */
  async getMarketDetail(tokenName) {
    return this._request('GET', `/api/trade/${encodeURIComponent(tokenName)}`);
  }

  /**
   * Paginated OHLCV candle history.
   * @param {string} tokenName
   * @param {string} resolution  1m|5m|15m|1h|4h|1d|1w
   * @param {number} [countBack] number of candles to fetch (default 200)
   * @param {number} [to]        Unix-ms upper bound for pagination
   */
  async getCandles(tokenName, resolution = '1h', countBack = 200, to) {
    return this._request('GET', `/api/trade/${encodeURIComponent(tokenName)}/candles`, {
      params: { resolution, countBack, ...(to ? { to } : {}) },
    });
  }

  /* ──────────────────── Portfolio (auth) ─────────────────────── */

  /** Balances, positions, PnL. */
  async getPortfolio() {
    return this._request('GET', '/api/portfolio', { auth: true });
  }

  /** Component view: cash + position breakdown. */
  async getPortfolioComponent() {
    return this._request('GET', '/api/portfolio/component', { auth: true });
  }

  /* ──────────────────── History (auth) ───────────────────────── */

  /** Active (resting) orders. */
  async getActiveOrders() {
    return this._request('GET', '/api/history/orders/active', { auth: true });
  }

  /** Completed order history. */
  async getOrderHistory(cursor) {
    return this._request('GET', '/api/history/orders', { auth: true, params: { cursor } });
  }

  /** Trade (fill) history. */
  async getTradeHistory(cursor) {
    return this._request('GET', '/api/history/trades', { auth: true, params: { cursor } });
  }

  /* ──────────────────── Orders (auth) ────────────────────────── */

  /** Request a one-time nonce for order placement. */
  async getNonce() {
    return this._request('POST', '/api/orders/nonce', { auth: true });
  }

  /**
   * Create an order (raw). Usually call limitBuy/limitSell/marketBuy/marketSell instead.
   * @param {Object} order  { propertyId, side, type, price, quantity, nonce }
   */
  async createOrder(order) {
    return this._request('POST', '/api/orders', { auth: true, body: order });
  }

  /** Cancel a single order by its id. */
  async cancelOrder(orderId) {
    return this._request('POST', '/api/orders/cancel', { auth: true, body: { orderId } });
  }

  /** Cancel all open orders. */
  async cancelAllOrders() {
    return this._request('POST', '/api/orders/cancel-all', { auth: true });
  }

  /* ──────────── convenience: nonce-wrapped order helpers ─────── */

  /**
   * Internal: get nonce then place order adhering strictly to OrderRequestBody schema.
   * @private
   */
  async _placeOrder(propertyId, tokenName, side, type, quantity, price) {
    const nonceRes = await this.getNonce();
    const nonce = nonceRes.nonce ?? nonceRes;

    const order = {
      propertyId: Number(propertyId),
      tokenName: String(tokenName),        // Required by server validation
      side: String(side).toUpperCase(),    // MUST be 'BUY' or 'SELL'
      type: String(type).toUpperCase(),    // MUST be 'LIMIT' or 'MARKET'
      quantity: Math.round(quantity * 10) / 10,   // max 1 dp
      timeInForce: 'GTC',                  // Required field: 'GTC' | 'IOC' | 'FOK' | 'GTD'
      deadline: 0,                         // Required field: Unix seconds or 0
      nonce,
    };

    if (order.type === 'LIMIT') {
      order.price = Math.round(price * 100) / 100;  // max 2 dp (cents)
    } else {
      order.price = 0; // market orders use price=0
    }

    return this.createOrder(order);
  }

  /** Place a limit buy order. */
  async limitBuy(propertyId, tokenName, quantity, price) {
    return this._placeOrder(propertyId, tokenName, 'buy', 'limit', quantity, price);
  }

  /** Place a limit sell order. */
  async limitSell(propertyId, tokenName, quantity, price) {
    return this._placeOrder(propertyId, tokenName, 'sell', 'limit', quantity, price);
  }

  /** Place a market buy order. */
  async marketBuy(propertyId, tokenName, quantity) {
    return this._placeOrder(propertyId, tokenName, 'buy', 'market', quantity, 0);
  }

  /** Place a market sell order. */
  async marketSell(propertyId, tokenName, quantity) {
    return this._placeOrder(propertyId, tokenName, 'sell', 'market', quantity, 0);
  }

  /* ──────────────── Leaderboard & Competition ───────────────── */

  async getLeaderboard() {
    return this._request('GET', '/api/leaderboard', { auth: true });
  }

  async getCompetitionInfo() {
    return this._request('GET', '/api/competition', { auth: true });
  }

  async getQueuePosition() {
    return this._request('GET', '/api/competition/queue-position', { auth: true });
  }
}

module.exports = { LoafClient };
