/**
 * app.js — Alpine.js global stores, router, and app boot sequence
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
    status: 'signed_out',   // 'signed_out' | 'signing_in' | 'signed_in'
    gapiReady: false,
  });

  Alpine.store('data', {
    manifest: null,         // { version, updatedAt, trades: [...], portfolioSnapshots: [...] }
    settings: null,         // user settings object
    allTrades: null,        // cached full trade list (used by analytics)
    loading: false,
    loadingMessage: '',
  });

  Alpine.store('portfolio', {
    account: null,          // Alpaca account object
    positions: [],          // Current positions
    orders: [],             // Open orders
    history: null,          // Portfolio history for chart
    clock: null,            // Market clock
    lastUpdated: null,
  });

  Alpine.store('ui', {
    activeView: 'dashboard',
    routeParams: {},
    navOpen: false,
    toast: null,
    toastTimer: null,
    paperMode: true,
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

// ── Trade factory ─────────────────────────────────────────────────────────────

const TradeFactory = {
  blank(overrides = {}) {
    return {
      id: Utils.uuid(),
      version: 1,
      createdAt: Utils.nowISO(),
      updatedAt: Utils.nowISO(),
      alpacaOrderId: null,
      symbol: '',
      side: 'buy',
      type: 'market',
      timeInForce: 'day',
      qty: null,
      notional: null,
      limitPrice: null,
      stopPrice: null,
      status: 'pending',         // pending | submitted | filled | canceled | rejected
      filledQty: null,
      filledAvgPrice: null,
      submittedAt: null,
      filledAt: null,
      canceledAt: null,
      estimatedCost: null,
      actualCost: null,
      strategyId: null,
      strategyName: null,
      claudeAdvisory: null,
      notes: '',
      tags: [],
      ...overrides,
    };
  },
};

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
        data.settings = settings;
      } else {
        const defaults = DefaultSettings.get();
        await Drive.saveSettings(defaults);
        data.settings = defaults;
      }

      // Initialize Alpaca if credentials exist
      Alpine.store('ui').paperMode = data.settings.brokerage.paperMode;
      if (data.settings.brokerage.apiKeyId && data.settings.brokerage.apiSecretKey) {
        Alpaca.init(data.settings);
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

  /** Refresh portfolio data from Alpaca */
  async refreshPortfolio() {
    if (!Alpaca.isConfigured()) return;

    const portfolio = Alpine.store('portfolio');
    try {
      const [account, positions, orders, clock] = await Promise.all([
        Alpaca.getAccount(),
        Alpaca.getPositions(),
        Alpaca.getOrders({ status: 'open' }),
        Alpaca.getClock(),
      ]);
      portfolio.account   = account;
      portfolio.positions = positions;
      portfolio.orders    = orders;
      portfolio.clock     = clock;
      portfolio.lastUpdated = Utils.nowISO();
    } catch (err) {
      console.error('Portfolio refresh error:', err);
      Toast.error('Could not fetch portfolio data from Alpaca.');
    }
  },

  /** Submit a trade to Alpaca and record it */
  async submitTrade(orderParams) {
    const trade = TradeFactory.blank({
      symbol: orderParams.symbol,
      side: orderParams.side,
      type: orderParams.type,
      timeInForce: orderParams.timeInForce,
      qty: orderParams.qty,
      notional: orderParams.notional,
      limitPrice: orderParams.limitPrice,
      stopPrice: orderParams.stopPrice,
      submittedAt: Utils.nowISO(),
      status: 'submitted',
    });

    try {
      const result = await Alpaca.submitOrder(orderParams);
      trade.alpacaOrderId = result.id;
      trade.status = result.status;
      if (result.filled_avg_price) {
        trade.filledAvgPrice = parseFloat(result.filled_avg_price);
        trade.filledQty = parseFloat(result.filled_qty);
        trade.filledAt = result.filled_at;
        trade.status = 'filled';
      }

      await Drive.saveTrade(trade);
      await Manifest.upsert(trade);
      Toast.success(`Order ${trade.status}: ${trade.side.toUpperCase()} ${trade.symbol}`);

      // Refresh portfolio after a short delay to let order settle
      setTimeout(() => App.refreshPortfolio(), 2000);

      return trade;
    } catch (err) {
      trade.status = 'rejected';
      console.error('Order error:', err);
      Toast.error(`Order failed: ${err.message}`);
      return null;
    }
  },

  /** Load full analytics data (all trades) */
  async loadAllForAnalytics() {
    const data = Alpine.store('data');
    if (data.allTrades) return data.allTrades;
    data.loading = true;
    data.loadingMessage = 'Loading full trade history...';
    try {
      const all = await Drive.loadAllTrades(data.manifest);
      data.allTrades = all;
      return all;
    } finally {
      data.loading = false;
      data.loadingMessage = '';
    }
  },
};

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('load', () => {
  Auth.init();
});
