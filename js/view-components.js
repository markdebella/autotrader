/**
 * view-components.js — Alpine data functions for all views
 *
 * Each view HTML uses x-data="ComponentName()" which calls these functions.
 * This app is a read-only dashboard — trading is handled via the Alpaca MCP server in Claude Code.
 */

// ── Dashboard ─────────────────────────────────────────────────────────────────

function Dashboard() {
  return {
    get alpacaConnected() { return Alpine.store('data').alpacaConfigured; },
    get account()    { return Alpine.store('portfolio').account; },
    get positions()  { return Alpine.store('portfolio').positions || []; },
    get openOrders() { return Alpine.store('portfolio').orders || []; },
    get clock()      { return Alpine.store('portfolio').clock; },
    get marketOpen() { return this.clock?.is_open ?? false; },
    get loadError()  { return Alpine.store('portfolio').error; },
    get lastUpdated() { return Alpine.store('portfolio').lastUpdated; },

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

    // "Explain this" modal — writes to the ui store; the modal renders in the app shell.
    openMetricExplain(key) {
      const data = Explain.metric(key, {
        account:    this.account,
        clock:      this.clock,
        positions:  this.positions,
        openOrders: this.openOrders,
        dailyPnl:   this.dailyPnl,
      });
      if (data) {
        const ui = Alpine.store('ui');
        ui.explainData = data;
        ui.explainOpen = true;
      }
    },

    openPositionExplain(pos) {
      const ui = Alpine.store('ui');
      ui.explainData = Explain.position(pos);
      ui.explainOpen = true;
    },

    init() {
      // Auto-refresh portfolio on view load
      if (Alpaca.isConfigured()) {
        App.refreshPortfolio();
      }
    },

    async refresh() {
      await App.refreshPortfolio();
      if (!this.loadError) Toast.success('Portfolio refreshed.');
    },
  };
}

// ── Analytics ─────────────────────────────────────────────────────────────────

function Analytics() {
  return {
    tab: 'portfolio',
    timeframe: '1M',

    get alpacaConnected() { return Alpine.store('data').alpacaConfigured; },

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
    riskLimits: { ...CONFIG.defaultRiskLimits },
    engine: 'gemini',   // recommendation engine: 'gemini' (AI) | 'rules'

    get driveFolderId() { return Drive.getFolderId(); },

    init() {
      const settings = Alpine.store('data').settings;
      if (settings) {
        // Merge over defaults so existing users get any newly-added limit fields.
        this.riskLimits = { ...CONFIG.defaultRiskLimits, ...(settings.riskLimits || {}) };
        // Treat any non-'rules' value (incl. legacy 'claude') as the AI engine.
        this.engine = settings.recommendations?.engine === 'rules' ? 'rules' : 'gemini';
      }
    },

    async setEngine(engine) {
      this.engine = engine;
      const settings = Alpine.store('data').settings;
      settings.recommendations = { ...(settings.recommendations || {}), engine };
      Alpine.store('data').settings = { ...settings };
      await Drive.saveSettings(settings);
      Toast.success(`Ideas engine set to ${engine === 'rules' ? 'Rules-based' : 'Gemini (AI)'}.`);
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

    init() {
      // Arrived here from an "Explain" modal glossary link? Open the glossary tab and
      // surface that term (filter to it), then clear the one-shot focus.
      const focus = Alpine.store('ui').glossaryFocus;
      if (focus) {
        this.tab = 'glossary';
        this.searchQuery = focus;
        Alpine.store('ui').glossaryFocus = '';
      }
    },
  };
}

// ── Recommendations (Phase 2: Recommend + Approve) ──────────────────────────────

function RecommendationsView() {
  return {
    // Pending first, then most-recently-created. Reads the reactive data store.
    get recs() {
      const list = Alpine.store('data').recommendations || [];
      const rank = { pending: 0, approved: 1, denied: 2 };
      return [...list].sort((a, b) =>
        (rank[a.status] - rank[b.status]) ||
        (new Date(b.createdAt) - new Date(a.createdAt))
      );
    },

    get pendingCount() {
      return (Alpine.store('data').recommendations || []).filter(r => r.status === 'pending').length;
    },

    generating: false,

    get engineLabel() {
      const e = (Alpine.store('data').settings?.recommendations?.engine) || 'gemini';
      return e === 'rules' ? 'Rules' : 'Gemini (AI)';
    },

    sizeLabel(rec)  { return Recs.sizeLabel(rec); },
    mcpCommand(rec) { return Recs.mcpCommand(rec); },

    /** Ask the backend to generate a fresh batch of ideas; keep approved/denied history. */
    async generate() {
      if (this.generating) return;
      this.generating = true;
      try {
        const settings = Alpine.store('data').settings || {};
        const engine = settings.recommendations?.engine || 'gemini';
        const res = await Api.generateRecommendations({
          engine,
          watchlist:  settings.watchlist  || CONFIG.defaultWatchlist,
          riskLimits: settings.riskLimits || CONFIG.defaultRiskLimits,
        });
        const fresh = res.recommendations || [];
        // Replace old pending/sample ideas with the new batch; preserve decided ones.
        const kept = (Alpine.store('data').recommendations || [])
          .filter(r => r.status === 'approved' || r.status === 'denied');
        const list = [...fresh, ...kept];
        Alpine.store('data').recommendations = list;
        await Drive.saveRecommendations({
          version: Recs.SCHEMA_VERSION, updatedAt: Utils.nowISO(), recommendations: list,
        });
        Company.ensure(fresh.map(r => r.symbol));
        if (res.fallback) {
          Toast.info(`Gemini was unavailable — generated ${fresh.length} rules-based idea${fresh.length === 1 ? '' : 's'}.`);
        } else {
          Toast.success(`Generated ${fresh.length} ${res.engine === 'rules' ? 'rules-based' : 'AI'} idea${fresh.length === 1 ? '' : 's'}.`);
        }
      } catch (err) {
        console.error('Generate recommendations failed:', err);
        Toast.error('Could not generate ideas. ' + (err.message || ''));
      } finally {
        this.generating = false;
      }
    },

    async approve(rec) {
      if (!rec.guardrail?.passed) return;       // never approve a limit-breaching idea
      // Copy the command FIRST, while the click's user-activation is still valid for the
      // clipboard API (it can lapse after an await on the Drive save).
      const copied = await this._copyText(this.mcpCommand(rec));
      rec.status = 'approved';
      rec.decidedAt = Utils.nowISO();
      await this._persist();
      Toast.success(copied
        ? 'Approved & command copied — paste it into Claude Code to place the order.'
        : 'Approved — copy the command below and run it in Claude Code.');
    },

    async deny(rec) {
      rec.status = 'denied';
      rec.decidedAt = Utils.nowISO();
      await this._persist();
      Toast.info('Recommendation denied.');
    },

    async copyCommand(rec) {
      const ok = await this._copyText(this.mcpCommand(rec));
      if (ok) Toast.success('Command copied — paste it into Claude Code.');
      else Toast.error('Could not copy automatically — select the text and copy it.');
    },

    async _copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch { return false; }
    },

    /** Persist the current list to Drive and re-trigger Alpine reactivity. */
    async _persist() {
      const data = Alpine.store('data');
      const list = data.recommendations;
      data.recommendations = [...list];
      try {
        await Drive.saveRecommendations({
          version: Recs.SCHEMA_VERSION,
          updatedAt: Utils.nowISO(),
          recommendations: list,
        });
      } catch (err) {
        console.error('Failed to save recommendations:', err);
        Toast.error('Saved your decision locally, but could not sync to Drive.');
      }
    },

    init() {
      // Resolve friendly names for any recommended tickers not already known.
      Company.ensure((Alpine.store('data').recommendations || []).map(r => r.symbol));
    },
  };
}
