/**
 * view-components.js — Alpine data functions for all views
 *
 * Each view HTML uses x-data="ComponentName()" which calls these functions.
 * This app is a read-only dashboard — trading is handled via the Alpaca MCP server in Claude Code.
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

    get driveFolderId() { return Drive.getFolderId(); },

    init() {
      const settings = Alpine.store('data').settings;
      if (settings) {
        this.apiKeyId = settings.brokerage.apiKeyId || '';
        this.apiSecretKey = settings.brokerage.apiSecretKey || '';
        this.paperMode = settings.brokerage.paperMode;
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
    tab: 'mcp',
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
