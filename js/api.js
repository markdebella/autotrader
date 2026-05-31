/**
 * api.js — client for the AutoTrader backend service (Cloud Run).
 *
 * The backend holds the Alpaca keys (in Secret Manager) and serves read-only portfolio
 * data. The browser authenticates with the owner's Google access token — it never holds
 * Alpaca keys (see SECURITY.md). Configured via CONFIG.apiBaseUrl.
 */

const Api = (() => {
  const base = () => (CONFIG.apiBaseUrl || '').replace(/\/+$/, '');

  return {
    isConfigured() { return !!CONFIG.apiBaseUrl; },

    /** Equity timeseries for the funds chart. period: 1D|1W|1M|3M|1A|all. */
    async getPortfolioHistory({ period = '1M', timeframe = '1D' } = {}) {
      const token = Auth.getToken();
      if (!token) throw new Error('Not signed in');
      const qs = new URLSearchParams({ period, timeframe }).toString();
      const resp = await fetch(base() + '/api/portfolio/history?' + qs, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!resp.ok) throw new Error(`Backend ${resp.status}`);
      return resp.json();
    },

    /** Daily bars per symbol for per-position charts. Returns { bars: { SYM: [...] } }. */
    async getBars(symbols, days = 30) {
      const token = Auth.getToken();
      if (!token) throw new Error('Not signed in');
      const qs = new URLSearchParams({ symbols: (symbols || []).join(','), days: String(days) }).toString();
      const resp = await fetch(base() + '/api/bars?' + qs, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!resp.ok) throw new Error(`Backend ${resp.status}`);
      return resp.json();
    },

    /** Read-only portfolio snapshot: { account, positions, orders, clock }. */
    async getPortfolio() {
      const token = Auth.getToken();
      if (!token) throw new Error('Not signed in');
      const resp = await fetch(base() + '/api/portfolio', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Backend ${resp.status}: ${body.slice(0, 200)}`);
      }
      return resp.json();
    },

    /** Ask the backend to generate trade ideas. engine: 'claude' | 'rules'. themes steer the AI. */
    async generateRecommendations({ engine, watchlist, riskLimits, themes }) {
      const token = Auth.getToken();
      if (!token) throw new Error('Not signed in');
      const resp = await fetch(base() + '/api/recommendations/generate', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, watchlist, riskLimits, themes }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Backend ${resp.status}: ${body.slice(0, 200)}`);
      }
      return resp.json();
    },

    /**
     * Place a paper order through the backend (which re-checks risk limits and holds the
     * Alpaca keys). Pass the approved recommendation + the current risk limits. Returns
     * Alpaca's order JSON. The browser never touches Alpaca keys.
     */
    async placeOrder({ symbol, side, dollars, qty, orderType, limitPrice, riskLimits }) {
      const token = Auth.getToken();
      if (!token) throw new Error('Not signed in');
      const resp = await fetch(base() + '/api/orders', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, side, dollars, qty, orderType, limitPrice, riskLimits }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        // Surface the backend's human-readable reason (e.g. a risk-limit or Alpaca rejection).
        let detail = body.slice(0, 300);
        try { detail = JSON.parse(body).detail || detail; } catch { /* keep raw */ }
        throw new Error(detail || `Backend ${resp.status}`);
      }
      return resp.json();
    },

    /**
     * Run one autonomous (paper) trading cycle on the backend. engine: 'ai' | 'rules'.
     * The backend enforces every risk limit + the kill switch and places the surviving
     * orders. Returns { engine, fallback, marketOpen, evaluated, placedCount, actions:[...] }.
     */
    async runAutonomous({ engine, watchlist, riskLimits, killSwitch, themes }) {
      const token = Auth.getToken();
      if (!token) throw new Error('Not signed in');
      const resp = await fetch(base() + '/api/autonomous/run', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, watchlist, riskLimits, killSwitch, themes }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        let detail = body.slice(0, 300);
        try { detail = JSON.parse(body).detail || detail; } catch { /* keep raw */ }
        throw new Error(detail || `Backend ${resp.status}`);
      }
      return resp.json();
    },
  };
})();
