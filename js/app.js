/**
 * app.js — Alpine.js global stores, router, and app boot sequence
 *
 * The browser holds no keys. Portfolio data, AI idea generation, and (paper) order
 * execution all go through the backend service, which holds the Alpaca/Claude keys in
 * Secret Manager (see SECURITY.md). This is what makes the app portable across computers.
 *
 * Boot order:
 *  1. Alpine stores initialized (before Alpine starts)
 *  2. Auth.init() — sets up GIS token client, loads GAPI
 *  3. User clicks Sign In → Auth.signIn() → token received
 *  4. App.onSignedIn() — bootstrap Drive folder, load manifest + settings
 *  5. Initialize Alpaca if credentials exist
 *  6. Router navigates to #dashboard
 */

// ── Stores ────────────────────────────────────────────────────────────────────

document.addEventListener('alpine:init', () => {

  Alpine.store('auth', {
    // Start in 'signing_in' if we were signed in before, so the silent token restore
    // (auth.js) runs without flashing the Sign In screen on reload.
    status: localStorage.getItem('at_signed_in') ? 'signing_in' : 'signed_out',  // 'signed_out' | 'signing_in' | 'signed_in'
    gapiReady: false,
  });

  Alpine.store('data', {
    manifest: null,         // { version, updatedAt, trades: [...], portfolioSnapshots: [...] }
    settings: null,         // user settings object
    allTrades: null,        // cached full trade list (used by analytics)
    recommendations: [],    // Phase 2: trade ideas to approve/deny (from recommendations.json)
    alpacaConfigured: false,// reactive mirror of Alpaca.isConfigured() — drives the
                            // dashboard connected/empty state (the Alpaca module's own
                            // flag is not reactive, so views must read this instead)
    loading: false,
    loadingMessage: '',
    // Count of recommendations still awaiting a decision — drives the Ideas nav badge.
    get pendingRecsCount() {
      return (this.recommendations || []).filter(r => r.status === 'pending').length;
    },
  });

  Alpine.store('portfolio', {
    account: null,          // Alpaca account object
    positions: [],          // Current positions
    orders: [],             // Open orders
    history: null,          // Portfolio history for chart
    clock: null,            // Market clock
    lastUpdated: null,
    error: null,            // human-readable message if the last refresh partially failed
  });

  Alpine.store('ui', {
    activeView: 'dashboard',
    routeParams: {},
    navOpen: false,
    toast: null,
    toastTimer: null,
    paperMode: true,
    // "Explain this" modal (Phase 1 education). Lives in the store so the modal can
    // render in the always-mounted app shell, independent of the current view.
    explainOpen: false,
    explainData: { title: '', context: '', glossary: [] },
    // A glossary term to surface when the Education view next loads (set when the user
    // clicks a term in the Explain modal). The Education component reads and clears it.
    glossaryFocus: '',
  });

});

// ── Toast helper ──────────────────────────────────────────────────────────────

const Toast = {
  show(message, type = 'info', duration = 3500) {
    const ui = Alpine.store('ui');
    clearTimeout(ui.toastTimer);
    ui.toast = { message, type };
    ui.toastTimer = setTimeout(() => { ui.toast = null; }, duration);
  },
  success(msg) { Toast.show(msg, 'success'); },
  error(msg)   { Toast.show(msg, 'error', 5000); },
  info(msg)    { Toast.show(msg, 'info'); },
};

// ── Router ────────────────────────────────────────────────────────────────────

const Router = {
  go(view, params = {}) {
    const ui = Alpine.store('ui');
    ui.navOpen = false;
    ui.activeView = view;
    ui.routeParams = params;
    window.location.hash = params.id ? `${view}/${params.id}` : view;
    window.scrollTo(0, 0);
  },

  parse() {
    const hash   = window.location.hash.replace('#', '') || 'dashboard';
    const parts  = hash.split('/');
    return { view: parts[0], id: parts[1] ?? null };
  },

  restore() {
    const { view, id } = Router.parse();
    const ui = Alpine.store('ui');
    ui.activeView  = view;
    ui.routeParams = id ? { id } : {};
  },
};

window.addEventListener('hashchange', () => Router.restore());

// ── App bootstrap ─────────────────────────────────────────────────────────────

const App = {
  /** Called by auth.js after a token is successfully received */
  async onSignedIn() {
    const data = Alpine.store('data');
    data.loading = true;
    data.loadingMessage = 'Connecting to your Drive...';

    try {
      // Ensure folder exists
      await Drive.bootstrapFolder();

      // Load manifest (or create empty one on first run)
      data.loadingMessage = 'Loading your trade history...';
      const manifest = await Drive.loadManifest();
      if (manifest) {
        Manifest.sortNewest(manifest);
        data.manifest = manifest;
      } else {
        const emptyManifest = {
          version: 1,
          updatedAt: Utils.nowISO(),
          trades: [],
          portfolioSnapshots: [],
        };
        await Drive.saveManifest(emptyManifest);
        data.manifest = emptyManifest;
        Toast.success('Welcome! Head to Settings to connect your Alpaca account.');
      }

      // Load settings (or create defaults on first run)
      const settings = await Drive.loadSettings();
      if (settings) {
        // Security: legacy installs stored Alpaca keys here. Keys now live only in
        // Secret Manager — strip any that linger and re-save so Drive holds no secrets.
        const b = settings.brokerage;
        if (b && (b.apiKeyId || b.apiSecretKey)) {
          delete b.apiKeyId;
          delete b.apiSecretKey;
          await Drive.saveSettings(settings);
        }
        data.settings = settings;
      } else {
        const defaults = DefaultSettings.get();
        await Drive.saveSettings(defaults);
        data.settings = defaults;
      }

      // Load recommendations (Phase 2). Seed samples on first run so the feed is
      // explorable before the user generates real ideas from the backend.
      const recDoc = await Drive.loadRecommendations();
      if (recDoc && Array.isArray(recDoc.recommendations)) {
        data.recommendations = recDoc.recommendations;
      } else {
        const seeded = Recs.sampleDoc();
        await Drive.saveRecommendations(seeded);
        data.recommendations = seeded.recommendations;
      }

      // Portfolio data now comes from the backend service (the Alpaca keys live in
      // Secret Manager and never touch the browser — see SECURITY.md). "Connected"
      // means the backend service URL is configured.
      Alpine.store('ui').paperMode = data.settings?.brokerage?.paperMode ?? true;
      data.alpacaConfigured = Api.isConfigured();
      if (data.alpacaConfigured) {
        await App.refreshPortfolio();
      }

      // Navigate to dashboard
      Router.go('dashboard');
    } catch (err) {
      console.error('Bootstrap error:', err);
      Toast.error('Could not connect to Google Drive. Please try again.');
      Alpine.store('auth').status = 'signed_out';
    } finally {
      data.loading = false;
      data.loadingMessage = '';
    }
  },

  /**
   * Refresh portfolio data from the backend service (which holds the Alpaca keys in
   * Secret Manager). The service returns { account, positions, orders, clock } in
   * Alpaca's raw JSON shape — the same shape the views already render.
   */
  async refreshPortfolio() {
    if (!Api.isConfigured()) return;

    const portfolio = Alpine.store('portfolio');
    try {
      const data = await Api.getPortfolio();
      portfolio.account     = data.account ?? null;
      portfolio.positions   = data.positions ?? [];
      portfolio.orders      = data.orders ?? [];
      portfolio.clock       = data.clock ?? null;
      portfolio.error       = null;
      portfolio.lastUpdated = Utils.nowISO();
      // Reconcile our logged trades with their latest Alpaca status (accepted → filled).
      try { await App.reconcileTrades(data.recentOrders || data.orders || []); }
      catch (e) { console.warn('Trade reconciliation skipped:', e); }
    } catch (err) {
      console.error('Portfolio refresh error:', err);
      portfolio.error = 'Could not load your portfolio from the backend service. '
                      + 'Make sure it is deployed and your keys are in Secret Manager.';
      Toast.error('Could not load your portfolio from the backend.');
    }
    // Friendly names come from the curated CONFIG.companyNames map now; the browser holds
    // no Alpaca keys, so Company.ensure() (which would call Alpaca) simply no-ops.
  },

  /**
   * Update logged trades from their latest Alpaca order state. Matches each manifest entry
   * to a recent order by id; when the status advances (e.g. accepted → filled) it rewrites
   * the full trade-{id}.json (preserving reasoning/links) and refreshes the manifest entry.
   * Catches autonomous-executor fills too — any order on the account, however placed.
   */
  async reconcileTrades(orders) {
    const store    = Alpine.store('data');
    const manifest = store.manifest;
    if (!manifest || !Array.isArray(manifest.trades) || !orders.length) return;

    const TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'done_for_day', 'replaced']);
    const byId = {};
    for (const o of orders) byId[o.id] = o;

    let changed = false;
    // Snapshot the ids first so iterating is unaffected by Manifest.upsert mutating the list.
    const entries = [...manifest.trades];
    for (const entry of entries) {
      const o = byId[entry.id];
      if (!o || entry.status === o.status || TERMINAL.has(entry.status)) continue;
      let trade;
      try { trade = await Drive.loadTrade(entry.id); } catch { continue; }
      trade.status         = o.status;
      trade.filledAvgPrice = o.filled_avg_price != null ? Number(o.filled_avg_price) : trade.filledAvgPrice;
      trade.filledAt       = o.filled_at || trade.filledAt;
      if (o.filled_qty != null && Number(o.filled_qty) > 0) trade.qty = Number(o.filled_qty);
      try {
        await Drive.saveTrade(trade);
        await Manifest.upsert(trade);   // refresh the lightweight entry + persist the manifest
        changed = true;
      } catch (e) {
        console.warn(`Could not persist reconciled trade ${entry.id}:`, e);
      }
      await new Promise(r => setTimeout(r, 120));   // gentle on Drive rate limits
    }
    if (changed) Toast.info('Updated trade fills from Alpaca.');
  },

  /**
   * Log a placed Alpaca order to the Drive trade journal + manifest (so it shows in Recent
   * Trades and reconciles to filled later). Shared by manual approve-execute and autopilot.
   * `meta` carries the originating intent: { symbol, side, dollars, qty, orderType,
   * limitPrice, reasoning, source, recommendationId }. Returns the saved trade.
   */
  async logPlacedOrder(order, meta) {
    const trade = {
      id:               order?.id || Utils.uuid(),
      symbol:           meta.symbol,
      side:             meta.side,
      qty:              order?.qty != null ? Number(order.qty) : (meta.qty ?? null),
      notional:         order?.notional != null ? Number(order.notional) : (meta.dollars ?? null),
      orderType:        meta.orderType || 'market',
      limitPrice:       meta.limitPrice ?? null,
      filledAvgPrice:   order?.filled_avg_price != null ? Number(order.filled_avg_price) : null,
      status:           order?.status || 'accepted',
      submittedAt:      order?.submitted_at || order?.created_at || Utils.nowISO(),
      filledAt:         order?.filled_at || null,
      reasoning:        meta.reasoning || '',
      source:           meta.source || 'manual',
      recommendationId: meta.recommendationId || null,
      paper:            true,
    };
    await Drive.saveTrade(trade);
    await Manifest.upsert(trade);   // refresh the lightweight entry + persist the manifest
    return trade;
  },

};

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  Auth.init();
});
