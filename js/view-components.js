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
    loading: false,
    _charts: {},        // canvas id -> Chart instance (so we can destroy before re-render)

    get alpacaConnected() { return Alpine.store('data').alpacaConfigured; },
    get positions() { return Alpine.store('portfolio').positions || []; },
    get trades() { return Alpine.store('data').manifest?.trades || []; },

    init() {
      if (Api.isConfigured()) this.$nextTick(() => this.loadChart());
      // Re-render when returning to the Portfolio tab (x-if rebuilds the canvases).
      this.$watch('tab', (t) => { if (t === 'portfolio') this.$nextTick(() => this.loadChart()); });
    },

    _destroy(id) {
      if (this._charts[id]) { try { this._charts[id].destroy(); } catch {} delete this._charts[id]; }
    },

    /** Load + render the equity curve and the per-position charts. */
    async loadChart() {
      if (!Api.isConfigured() || typeof Chart === 'undefined') return;
      this.loading = true;
      try {
        const resolution = this.timeframe === '1D' ? '15Min' : '1D';
        const hist = await Api.getPortfolioHistory({ period: this.timeframe, timeframe: resolution });
        this.$nextTick(() => this.renderEquityChart(hist));
      } catch (e) {
        console.error('Portfolio history failed:', e);
        Toast.error('Could not load portfolio history.');
      } finally {
        this.loading = false;
      }
      this.renderPositionCharts();
    },

    renderEquityChart(hist) {
      const el = document.getElementById('portfolio-chart');
      if (!el || typeof Chart === 'undefined' || !hist) return;
      const eq = (hist.equity || []).map(Number);
      const ts = hist.timestamp || [];
      if (!eq.length) { this._destroy('portfolio-chart'); return; }
      const labels = ts.map(t => {
        const d = new Date(t * 1000);
        return this.timeframe === '1D'
          ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      });
      const base = hist.base_value != null ? Number(hist.base_value) : eq[0];
      const up = eq[eq.length - 1] >= base;
      const line = up ? '#22c55e' : '#ef4444';
      this._destroy('portfolio-chart');
      this._charts['portfolio-chart'] = new Chart(el, {
        type: 'line',
        data: { labels, datasets: [{ data: eq, borderColor: line, backgroundColor: 'rgba(59,130,246,0.08)',
                 fill: true, pointRadius: 0, tension: 0.25, borderWidth: 2 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false },
            tooltip: { callbacks: { label: (c) => Utils.formatCurrency(c.parsed.y) } } },
          scales: {
            x: { ticks: { maxTicksLimit: 6, color: '#94a3b8' }, grid: { display: false } },
            y: { ticks: { callback: (v) => '$' + v, color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.12)' } },
          },
        },
      });
    },

    async renderPositionCharts() {
      if (typeof Chart === 'undefined') return;
      const syms = this.positions.map(p => p.symbol);
      if (!syms.length) return;
      let barsBySym = {};
      try { barsBySym = (await Api.getBars(syms, 30)).bars || {}; }
      catch (e) { console.warn('Bars fetch failed:', e); return; }
      this.$nextTick(() => {
        for (const p of this.positions) {
          const id = 'pos-chart-' + p.symbol;
          const el = document.getElementById(id);
          if (!el) continue;
          const closes = (barsBySym[p.symbol] || []).map(b => Number(b.c)).filter(n => !isNaN(n));
          this._destroy(id);
          if (closes.length < 2) continue;
          const up = closes[closes.length - 1] >= closes[0];
          this._charts[id] = new Chart(el, {
            type: 'line',
            data: { labels: closes.map((_, i) => i),
                    datasets: [{ data: closes, borderColor: up ? '#22c55e' : '#ef4444',
                      backgroundColor: 'transparent', fill: false, pointRadius: 0, tension: 0.3, borderWidth: 1.5 }] },
            options: { responsive: true, maintainAspectRatio: false,
              plugins: { legend: { display: false }, tooltip: { enabled: false } },
              scales: { x: { display: false }, y: { display: false } } },
          });
        }
      });
    },

    companyName(sym) { return Company.name(sym); },
  };
}

// ── Settings ──────────────────────────────────────────────────────────────────

function Settings() {
  return {
    riskLimits: { ...CONFIG.defaultRiskLimits },
    watchlistText: '',   // editable comma/space/newline-separated tickers
    themesText: '',      // editable focus areas, one per line

    get driveFolderId() { return Drive.getFolderId(); },

    /** Parse the watchlist textarea into a clean ticker array. */
    _parseWatchlist() {
      return [...new Set((this.watchlistText || '').toUpperCase().split(/[\s,]+/)
        .map(s => s.trim()).filter(Boolean))].slice(0, 40);
    },
    /** Parse the focus-areas textarea (one theme per line, or comma-separated). */
    _parseThemes() {
      return (this.themesText || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
    },

    async saveFocus() {
      const settings = Alpine.store('data').settings || {};
      settings.watchlist = this._parseWatchlist();
      settings.themes    = this._parseThemes();
      Alpine.store('data').settings = { ...settings };
      await Drive.saveSettings(settings);
      Toast.success('Investing focus saved.');
    },

    // ── Secret Manager key management (shown as copyable Cloud Shell commands) ──
    // Every key lives ONLY in Google Secret Manager; these commands rotate a key in place.
    get gcpProject() { return 'autotrader-497920'; },
    secretKeys: [
      { label: 'Claude (Anthropic) API key', name: 'claude-api-key',     note: 'Powers AI trade ideas. Create/rotate at console.anthropic.com.' },
      { label: 'Alpaca paper API key',        name: 'alpaca-paper-key',    note: 'Regenerate in the Alpaca dashboard first, then update both Alpaca secrets.' },
      { label: 'Alpaca paper secret key',      name: 'alpaca-paper-secret', note: 'The secret half of the Alpaca paper key pair.' },
    ],
    /** Secure update command for one secret (typed at a hidden prompt — never hits shell history). */
    updateCmd(name) {
      return `read -rs -p "New value: " K\n`
           + `printf "%s" "$K" | gcloud secrets versions add ${name} --data-file=-\n`
           + `unset K; echo`;
    },
    /** Forces the backend to re-read secrets (it caches them per running instance). */
    get refreshCmd() {
      return `gcloud run services update autotrader-api --region us-west1 `
           + `--update-env-vars "SECRETS_REFRESHED_AT=$(date +%s)"`;
    },
    async copyText(text) {
      try { await navigator.clipboard.writeText(text); Toast.success('Command copied.'); }
      catch { Toast.error('Could not copy — select the text and copy it manually.'); }
    },

    init() {
      const settings = Alpine.store('data').settings;
      if (settings) {
        // Merge over defaults so existing users get any newly-added limit fields.
        this.riskLimits = { ...CONFIG.defaultRiskLimits, ...(settings.riskLimits || {}) };
      }
      const wl = (settings && settings.watchlist) || CONFIG.defaultWatchlist || [];
      const th = (settings && settings.themes)    || CONFIG.defaultThemes    || [];
      this.watchlistText = wl.join(', ');
      this.themesText    = th.join('\n');
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
          themes:     settings.themes     || CONFIG.defaultThemes,
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
          const trade = await App.logPlacedOrder(order, {
            symbol: rec.symbol, side: rec.side, dollars: rec.dollars, qty: rec.qty,
            orderType: rec.orderType, limitPrice: rec.limitPrice,
            reasoning: rec.reasoning, source: rec.source, recommendationId: rec.id,
          });
          rec.tradeId = trade.id;
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

// ── Autopilot (hybrid Phase 3: autonomous paper trading) ────────────────────────

function AutopilotView() {
  return {
    engine: 'ai',          // 'ai' (default) | 'rules'
    killSwitch: false,
    running: false,
    lastRun: null,         // last cycle's backend summary (ephemeral; trades persist to Drive)
    lastRunAt: null,

    init() {
      const ap = (Alpine.store('data').settings || {}).autopilot || {};
      this.engine = ap.engine === 'rules' ? 'rules' : 'ai';
      this.killSwitch = !!ap.killSwitch;
    },

    get actions() { return this.lastRun?.actions || []; },

    /** Persist engine + kill-switch to settings.autopilot in Drive. */
    async _saveConfig() {
      const settings = Alpine.store('data').settings || {};
      settings.autopilot = { engine: this.engine, killSwitch: this.killSwitch };
      Alpine.store('data').settings = { ...settings };
      try { await Drive.saveSettings(settings); }
      catch (e) { console.error('Save autopilot config failed:', e); Toast.error('Could not save autopilot settings.'); }
    },

    async setEngine(e) { this.engine = e === 'rules' ? 'rules' : 'ai'; await this._saveConfig(); },

    async toggleKillSwitch() {
      this.killSwitch = !this.killSwitch;
      await this._saveConfig();
      Toast.info(this.killSwitch ? 'Kill switch ON — autopilot is halted.' : 'Kill switch off — autopilot can trade.');
    },

    actionLabel(a) {
      const size = a.dollars != null ? Utils.formatCurrency(a.dollars)
                 : (a.qty != null ? `${Utils.formatShares(a.qty)} sh` : '');
      return `${(a.side || '').toUpperCase()} ${size} ${a.symbol}`.trim();
    },

    /** Run one paper cycle now. The backend enforces all limits + the kill switch. */
    async runNow() {
      if (this.running) return;
      this.running = true;
      try {
        const settings = Alpine.store('data').settings || {};
        const res = await Api.runAutonomous({
          engine:     this.engine,
          watchlist:  settings.watchlist  || CONFIG.defaultWatchlist,
          riskLimits: settings.riskLimits || CONFIG.defaultRiskLimits,
          killSwitch: this.killSwitch,
          themes:     settings.themes     || CONFIG.defaultThemes,
        });
        this.lastRun   = res;
        this.lastRunAt = Utils.nowISO();

        if (res.halted) { Toast.info(res.reason || 'Cycle halted.'); return; }

        // Log every placed order to the Drive trade journal so it shows in Recent Trades.
        const placed = (res.actions || []).filter(a => a.status === 'placed' && a.order);
        for (const a of placed) {
          try {
            await App.logPlacedOrder(a.order, {
              symbol: a.symbol, side: a.side, dollars: a.dollars, qty: a.qty,
              orderType: 'market', reasoning: a.reason, source: 'auto-' + res.engine,
            });
          } catch (e) { console.warn('Autopilot trade-log failed:', e); }
        }
        Company.ensure(placed.map(a => a.symbol));

        const eng = res.engine === 'ai' ? 'AI' : 'rules';
        if (res.placedCount > 0) Toast.success(`Autopilot (${eng}) placed ${res.placedCount} paper order${res.placedCount === 1 ? '' : 's'}.`);
        else Toast.info(`Autopilot (${eng}) ran — no trades this cycle.`);
        if (res.fallback) Toast.info('Claude was unavailable — used the rules engine this cycle.');
        App.refreshPortfolio();
      } catch (err) {
        console.error('Autopilot run failed:', err);
        Toast.error('Autopilot run failed. ' + (err.message || ''));
      } finally {
        this.running = false;
      }
    },
  };
}
