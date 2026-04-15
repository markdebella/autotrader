/**
 * view-components.js — Alpine data functions for all views
 *
 * Each view HTML uses x-data="ComponentName()" which calls these functions.
 */

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard() {
  return {
    get alpacaConnected() { return Alpaca.isConfigured(); },
    get account()    { return Alpine.store('portfolio').account; },
    get positions()  { return Alpine.store('portfolio').positions || []; },
    get openOrders() { return Alpine.store('portfolio').orders || []; },
    get clock()      { return Alpine.store('portfolio').clock; },
    get marketOpen() { return this.clock?.is_open ?? false; },

    get dailyPnl() {
      if (!this.account) return 0;
      const equity = parseFloat(this.account.equity || 0);
      const lastEquity = parseFloat(this.account.last_equity || 0);
      return equity - lastEquity;
    },

    get recentTrades() {
      const manifest = Alpine.store('data').manifest;
      if (!manifest?.trades) return [];
      return manifest.trades.slice(0, 8);
    },

    init() {
      // Auto-refresh portfolio on view load
      if (Alpaca.isConfigured()) {
        App.refreshPortfolio();
      }
    },

    async refresh() {
      await App.refreshPortfolio();
      Toast.success('Portfolio refreshed.');
    },
  };
}

// ── Trade ──────────────────────────────────────────────────────────────────────

function Trade() {
  return {
    symbol: '',
    side: 'buy',
    orderType: 'market',
    qty: null,
    limitPrice: null,
    stopPrice: null,
    timeInForce: 'day',
    notes: '',
    showConfirm: false,

    get alpacaConnected() { return Alpaca.isConfigured(); },

    get orderTypeDescription() {
      const ot = CONFIG.orderTypes.find(x => x.id === this.orderType);
      return ot?.description || '';
    },

    get tifDescription() {
      const tif = CONFIG.timeInForce.find(x => x.id === this.timeInForce);
      return tif?.description || '';
    },

    get canSubmit() {
      if (!this.symbol.trim()) return false;
      if (!this.qty || this.qty <= 0) return false;
      if ((this.orderType === 'limit' || this.orderType === 'stop_limit') && !this.limitPrice) return false;
      if ((this.orderType === 'stop' || this.orderType === 'stop_limit') && !this.stopPrice) return false;
      return true;
    },

    init() {
      // Pre-fill symbol from route params (e.g., from watchlist click)
      const params = Alpine.store('ui').routeParams;
      if (params.id) {
        this.symbol = params.id.toUpperCase();
      }
    },

    async submitOrder() {
      this.showConfirm = false;

      const trade = await App.submitTrade({
        symbol: this.symbol,
        side: this.side,
        type: this.orderType,
        timeInForce: this.timeInForce,
        qty: this.qty.toString(),
        limitPrice: this.limitPrice ? this.limitPrice.toString() : undefined,
        stopPrice: this.stopPrice ? this.stopPrice.toString() : undefined,
      });

      if (trade) {
        // Save notes if provided
        if (this.notes.trim()) {
          trade.notes = this.notes;
          await Drive.saveTrade(trade);
        }
        // Reset form
        this.symbol = '';
        this.qty = null;
        this.limitPrice = null;
        this.stopPrice = null;
        this.notes = '';
      }
    },
  };
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

function Watchlist() {
  return {
    newSymbol: '',

    get watchlist() {
      return Alpine.store('data').settings?.watchlist || [];
    },

    init() {},

    async addSymbol() {
      const sym = this.newSymbol.trim().toUpperCase();
      if (!sym) return;

      const settings = Alpine.store('data').settings;
      if (settings.watchlist.includes(sym)) {
        Toast.info(`${sym} is already on your watchlist.`);
        this.newSymbol = '';
        return;
      }

      settings.watchlist.push(sym);
      Alpine.store('data').settings = { ...settings };
      await Drive.saveSettings(settings);
      Toast.success(`Added ${sym} to watchlist.`);
      this.newSymbol = '';
    },

    async removeSymbol(idx) {
      const settings = Alpine.store('data').settings;
      const sym = settings.watchlist[idx];
      settings.watchlist.splice(idx, 1);
      Alpine.store('data').settings = { ...settings };
      await Drive.saveSettings(settings);
      Toast.info(`Removed ${sym} from watchlist.`);
    },
  };
}

// ── Analytics ─────────────────────────────────────────────────────────────────

function Analytics() {
  return {
    tab: 'portfolio',
    timeframe: '1M',

    get alpacaConnected() { return Alpaca.isConfigured(); },

    get trades() {
      const manifest = Alpine.store('data').manifest;
      return manifest?.trades || [];
    },

    init() {
      if (Alpaca.isConfigured()) {
        this.loadChart();
      }
    },

    async loadChart() {
      // Portfolio chart will be implemented in Phase 3
      // For now, just show the canvas placeholder
    },
  };
}

// ── Settings ──────────────────────────────────────────────────────────────────

function Settings() {
  return {
    apiKeyId: '',
    apiSecretKey: '',
    paperMode: true,
    showSecret: false,
    testing: false,
    connectionStatus: null,
    riskLimits: { ...CONFIG.defaultRiskLimits },

    get driveFolderId() { return Drive.getFolderId(); },

    init() {
      const settings = Alpine.store('data').settings;
      if (settings) {
        this.apiKeyId = settings.brokerage.apiKeyId || '';
        this.apiSecretKey = settings.brokerage.apiSecretKey || '';
        this.paperMode = settings.brokerage.paperMode;
        this.riskLimits = { ...CONFIG.defaultRiskLimits, ...settings.riskLimits };
      }
    },

    confirmLiveMode() {
      if (this.paperMode) {
        if (confirm('WARNING: Switching to LIVE mode means trades will use REAL MONEY.\n\nAre you absolutely sure you want to trade with real funds?')) {
          if (confirm('Second confirmation: Live trading carries real financial risk. You could lose money.\n\nConfirm switch to LIVE mode?')) {
            this.paperMode = false;
          }
        }
      }
    },

    async testConnection() {
      this.testing = true;
      this.connectionStatus = null;

      // Temporarily init Alpaca with current form values
      const tempSettings = {
        brokerage: {
          apiKeyId: this.apiKeyId,
          apiSecretKey: this.apiSecretKey,
          paperMode: this.paperMode,
        },
      };
      Alpaca.init(tempSettings);

      try {
        const account = await Alpaca.testConnection();
        this.connectionStatus = {
          ok: true,
          message: `Connected! Account: ${account.account_number} | Buying power: ${Utils.formatCurrency(parseFloat(account.buying_power))} | Status: ${account.status}`,
        };
      } catch (err) {
        this.connectionStatus = {
          ok: false,
          message: `Connection failed: ${err.message}`,
        };
      } finally {
        this.testing = false;
      }
    },

    async saveCredentials() {
      const settings = Alpine.store('data').settings;
      settings.brokerage.apiKeyId = this.apiKeyId;
      settings.brokerage.apiSecretKey = this.apiSecretKey;
      settings.brokerage.paperMode = this.paperMode;

      Alpine.store('data').settings = { ...settings };
      Alpine.store('ui').paperMode = this.paperMode;
      await Drive.saveSettings(settings);
      Alpaca.init(settings);

      Toast.success('Credentials saved.');

      // Refresh portfolio if connected
      if (Alpaca.isConfigured()) {
        await App.refreshPortfolio();
      }
    },

    async saveRiskLimits() {
      const settings = Alpine.store('data').settings;
      settings.riskLimits = { ...this.riskLimits };
      Alpine.store('data').settings = { ...settings };
      await Drive.saveSettings(settings);
      Toast.success('Risk limits saved.');
    },

    async exportData() {
      const manifest = Alpine.store('data').manifest;
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `autotrader-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Toast.success('Export downloaded.');
    },
  };
}

// ── Education ─────────────────────────────────────────────────────────────────

function Education() {
  return {
    tab: 'glossary',
    searchQuery: '',

    get filteredGlossary() {
      const q = this.searchQuery.toLowerCase().trim();
      if (!q) return CONFIG.glossary;
      return CONFIG.glossary.filter(item =>
        item.term.toLowerCase().includes(q) ||
        item.definition.toLowerCase().includes(q)
      );
    },

    init() {},
  };
}
