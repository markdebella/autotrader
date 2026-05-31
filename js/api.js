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
  };
})();
