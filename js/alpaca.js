/**
 * alpaca.js — Alpaca Markets API client (read-only)
 *
 * Read-only REST calls to Alpaca's Trading API v2.
 * Trading is handled via the Alpaca MCP server in Claude Code.
 * Credentials are loaded from settings (stored in Google Drive).
 * CORS-enabled — works directly from the browser.
 */

const Alpaca = (() => {
  let baseUrl    = '';
  let apiKeyId   = '';
  let apiSecret  = '';
  let configured = false;

  /** Internal fetch wrapper with auth headers */
  async function request(method, path, body = null, params = {}) {
    const url = new URL(path, baseUrl);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, v);
    });

    const opts = {
      method,
      headers: {
        'APCA-API-KEY-ID':     apiKeyId,
        'APCA-API-SECRET-KEY': apiSecret,
        'Content-Type':        'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const response = await fetch(url.toString(), opts);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Alpaca ${method} ${path}: ${response.status} ${text}`);
    }
    if (response.status === 204) return null; // DELETE responses
    return response.json();
  }

  return {
    /** Initialize with credentials from settings */
    init(settings) {
      const b = settings.brokerage;
      apiKeyId  = b.apiKeyId || '';
      apiSecret = b.apiSecretKey || '';
      baseUrl   = b.paperMode ? CONFIG.alpaca.paperBaseUrl : CONFIG.alpaca.liveBaseUrl;
      configured = !!(apiKeyId && apiSecret);
    },

    isConfigured() { return configured; },
    isPaper()      { return baseUrl === CONFIG.alpaca.paperBaseUrl; },

    /** Test the connection — returns account info or throws */
    async testConnection() {
      return await request('GET', '/v2/account');
    },

    // ── Account ───────────────────────────────────────────────────────────────

    async getAccount() {
      return await request('GET', '/v2/account');
    },

    // ── Positions ─────────────────────────────────────────────────────────────

    async getPositions() {
      return await request('GET', '/v2/positions');
    },

    async getPosition(symbol) {
      return await request('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
    },

    // ── Orders (read-only) ──────────────────────────────────────────────────────

    async getOrders(params = {}) {
      return await request('GET', '/v2/orders', null, {
        status: params.status || 'open',
        limit:  params.limit || 50,
        direction: params.direction || 'desc',
      });
    },

    // ── Portfolio History ─────────────────────────────────────────────────────

    async getPortfolioHistory(params = {}) {
      return await request('GET', '/v2/account/portfolio/history', null, {
        period:    params.period || '1M',
        timeframe: params.timeframe || '1D',
      });
    },

    // ── Market Clock ──────────────────────────────────────────────────────────

    async getClock() {
      return await request('GET', '/v2/clock');
    },
  };
})();
