/**
 * view-components.js — Alpine data functions for all views
 *
 * Each view HTML uses x-data="ComponentName()" which calls these functions.
 * The browser holds no Alpaca/Claude keys: it reads portfolio data, generates ideas, and
 * places (paper) orders by calling the backend service, which holds the keys in Secret
 * Manager and acts on the browser's behalf (see SECURITY.md).
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

    get driveFolderId() { return Drive.getFolderId(); },

    init() {
      const settings = Alpine.store('data').settings;
      if (settings) {
        // Merge over defaults so existing users get any newly-added limit fields.
        this.riskLimits = { ...CONFIG.defaultRiskLimits, ...(settings.riskLimits || {}) };
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
      const rank = { pending: 0, approved: 1, executed: 2, denied: 3 };
      return [...list].sort((a, b) =>
        ((rank[a.status] ?? 9) - (rank[b.status] ?? 9)) ||
        (new Date(b.createdAt) - new Date(a.createdAt))
      );
    },

    get pendingCount() {
      return (Alpine.store('data').recommendations || []).filter(r => r.status === 'pending').length;
    },

    generating: false,
    executingId: null,    // id of the rec currently being placed (disables its button)

    sizeLabel(rec) { return Recs.sizeLabel(rec); },

    /**
     * Ask the backend for a fresh batch of ideas — AI (Claude) first, with an automatic
     * rules-based fallback if Claude is unavailable. Keeps approved/executed/denied history.
     */
    async generate() {
      if (this.generating) return;
      this.generating = true;
      try {
        const settings = Alpine.store('data').settings || {};
        const res = await Api.generateRecommendations({
          engine:     'claude',   // AI-primary; the backend falls back to rules if Claude is down
          watchlist:  settings.watchlist  || CONFIG.defaultWatchlist,
          riskLimits: settings.riskLimits || CONFIG.defaultRiskLimits,
        });
        const fresh = res.recommendations || [];
        // Replace old pending/sample ideas with the new batch; preserve decided/executed ones.
        const kept = (Alpine.store('data').recommendations || [])
          .filter(r => r.status === 'approved' || r.status === 'executed' || r.status === 'denied');
        const list = [...fresh, ...kept];
        Alpine.store('data').recommendations = list;
        await Drive.saveRecommendations({
          version: Recs.SCHEMA_VERSION, updatedAt: Utils.nowISO(), recommendations: list,
        });
        Company.ensure(fresh.map(r => r.symbol));
        if (res.fallback) {
          Toast.info(`Claude was unavailable — showing ${fresh.length} rules-based idea${fresh.length === 1 ? '' : 's'} instead.`);
        } else {
          Toast.success(`Generated ${fresh.length} ${res.engine === 'claude' ? 'AI' : 'rules-based'} idea${fresh.length === 1 ? '' : 's'}.`);
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
      rec.status = 'approved';
      rec.decidedAt = Utils.nowISO();
      await this._persist();
      Toast.success('Approved — press "Place paper order" to execute it.');
    },

    /** Place the approved (paper) order through the backend, log it, then mark it executed. */
    async execute(rec) {
      if (this.executingId || !rec.guardrail?.passed) return;
      this.executingId = rec.id;
      try {
        const settings = Alpine.store('data').settings || {};
        const order = await Api.placeOrder({
          symbol:     rec.symbol,
          side:       rec.side,
          dollars:    rec.dollars,
          qty:        rec.qty,
          orderType:  rec.orderType,
          limitPrice: rec.limitPrice,
          riskLimits: settings.riskLimits || CONFIG.defaultRiskLimits,
        });
        rec.status = 'executed';
        rec.order  = { id: order.id || null, submittedAt: Utils.nowISO() };

        // Log the placed order to the Drive trade journal, linked back to this idea, so it
        // shows in Recent Trades and builds the audit trail (basis for shadow-tracking + Phase 3).
        let logged = true;
        try {
          const trade = {
            id:               order.id || Utils.uuid(),
            symbol:           rec.symbol,
            side:             rec.side,
            qty:              order.qty != null ? Number(order.qty) : null,
            notional:         order.notional != null ? Number(order.notional) : (rec.dollars ?? null),
            orderType:        rec.orderType,
            limitPrice:       rec.limitPrice ?? null,
            filledAvgPrice:   order.filled_avg_price != null ? Number(order.filled_avg_price) : null,
            status:           order.status || 'accepted',
            submittedAt:      order.submitted_at || order.created_at || Utils.nowISO(),
            filledAt:         order.filled_at || null,
            reasoning:        rec.reasoning,
            source:           rec.source,
            recommendationId: rec.id,
            paper:            true,
          };
          rec.tradeId = trade.id;
          await Drive.saveTrade(trade);
          await Manifest.upsert(trade);   // updates the in-memory manifest + saves it to Drive
        } catch (logErr) {
          logged = false;
          console.error('Order placed but trade-log write failed:', logErr);
        }

        await this._persist();
        Toast.success(`Paper order placed: ${rec.side} ${this.sizeLabel(rec)} ${rec.symbol}.`
                      + (logged ? '' : ' (note: trade-log save failed)'));
        // Reflect the new order on the dashboard next time it's viewed.
        App.refreshPortfolio();
      } catch (err) {
        console.error('Place order failed:', err);
        Toast.error('Could not place the order. ' + (err.message || ''));
      } finally {
        this.executingId = null;
      }
    },

    async deny(rec) {
      rec.status = 'denied';
      rec.decidedAt = Utils.nowISO();
      await this._persist();
      Toast.info('Recommendation denied.');
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
