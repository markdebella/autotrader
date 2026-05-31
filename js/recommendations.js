/**
 * recommendations.js — Phase 2 (Recommend + Approve) helpers
 *
 * A "recommendation" is a trade idea for the user to approve or deny. The browser
 * NEVER places orders and the LLM is NEVER in the page (see ROADMAP.md): recommendations
 * are written to the user's Drive (recommendations.json) by Claude via the Alpaca MCP
 * server, out-of-band. This module only defines the schema, seeds samples so the feed is
 * explorable, and turns an approved recommendation into a natural-language MCP command.
 *
 * Drive document shape (recommendations.json):
 *   { version, updatedAt, recommendations: [ Recommendation, ... ] }
 *
 * Recommendation:
 *   {
 *     id, symbol, side: 'buy'|'sell', orderType: 'market'|'limit',
 *     dollars: number|null, qty: number|null, limitPrice: number|null,
 *     reasoning: string,
 *     guardrail: { passed: boolean, notes: string },
 *     createdAt, decidedAt, status: 'pending'|'approved'|'denied',
 *     source: 'claude'|'sample'
 *   }
 */

const Recs = (() => {
  const SCHEMA_VERSION = 1;

  /** A short natural-language command to run in Claude Code (Alpaca MCP) to execute. */
  function mcpCommand(rec) {
    const verb   = rec.side === 'sell' ? 'Sell' : 'Buy';
    const amount = rec.dollars != null
      ? `$${rec.dollars} of ${rec.symbol}`
      : `${rec.qty} share${rec.qty === 1 ? '' : 's'} of ${rec.symbol}`;
    const price  = (rec.orderType === 'limit' && rec.limitPrice != null)
      ? ` with a limit price of $${rec.limitPrice}`
      : ' at market price';
    return `${verb} ${amount}${price}.`;
  }

  /** Human-readable size, e.g. "$10" or "2 shares". */
  function sizeLabel(rec) {
    return rec.dollars != null
      ? Utils.formatCurrency(rec.dollars)
      : `${Utils.formatShares(rec.qty)} share${rec.qty === 1 ? '' : 's'}`;
  }

  /** A fresh sample document so the feed is explorable before Claude writes real recs. */
  function sampleDoc() {
    const now = Utils.nowISO();
    const mk = (o) => ({
      id: Utils.uuid(),
      orderType: 'market',
      dollars: null, qty: null, limitPrice: null,
      createdAt: now, decidedAt: null,
      status: 'pending', source: 'sample',
      ...o,
    });
    return {
      version: SCHEMA_VERSION,
      updatedAt: now,
      recommendations: [
        mk({
          symbol: 'AAPL', side: 'buy', dollars: 10,
          reasoning: 'A small starter position in a widely-held name. Sized tiny so a single trade can teach you how orders, fills, and unrealized P&L work without meaningful risk.',
          guardrail: { passed: true, notes: '$10 order ≤ $10 max-order; ≤ $25 max-per-position; within 3 trades/day.' },
        }),
        mk({
          symbol: 'MSFT', side: 'buy', dollars: 8,
          reasoning: 'Diversifies the sample beyond a single stock. Kept under the per-order cap to demonstrate fractional-share sizing on a higher-priced name.',
          guardrail: { passed: true, notes: '$8 order ≤ $10 max-order; ≤ $25 max-per-position; within 3 trades/day.' },
        }),
        mk({
          symbol: 'TSLA', side: 'buy', dollars: 10,
          reasoning: 'A more volatile name to illustrate how unrealized P&L can swing day to day — useful for learning, still sized at the minimum.',
          guardrail: { passed: true, notes: '$10 order ≤ $10 max-order; ≤ $25 max-per-position; within 3 trades/day.' },
        }),
      ],
    };
  }

  /**
   * A ready-to-paste prompt for Claude Code (uses the user's Claude subscription — no API
   * key) to generate AI trade ideas as JSON. You then paste the JSON into the app's
   * "Import ideas" box; the browser fills in the rest and saves to Drive.
   */
  function claudeCodePrompt(watchlist, riskLimits) {
    const rl = riskLimits || {};
    const list = (watchlist || []).join(', ');
    return [
      'Help me generate PAPER-trading ideas for my AutoTrader app.',
      '',
      `Watchlist: ${list}`,
      `Risk limits: max $${rl.maxOrderDollars ?? 10} per order, max $${rl.maxPositionDollars ?? 25} per position, max ${rl.maxTradesPerDay ?? 3} trades/day.`,
      '',
      '1. Analyze the watchlist (use the Alpaca MCP for quotes/history if available, otherwise your best judgment). Propose UP TO 5 small starter ideas. Education-first, not financial advice. Prefer buys on pullbacks; only suggest a sell for a symbol I already hold. Keep each idea\'s dollars <= my max-order limit.',
      '',
      '2. Output ONLY a JSON array in a code block, where each item is exactly:',
      '   { "symbol": "AAPL", "side": "buy"|"sell", "dollars": <number>, "reasoning": "<1-2 plain sentences>" }',
      '',
      'I\'ll paste that array into the app\'s "Import ideas" box — it fills in the IDs, guardrail checks, and timestamps automatically.',
    ].join('\n');
  }

  /** Risk-limit check for an idea (mirrors the backend guardrail). */
  function guardrail(dollars, riskLimits) {
    const rl = riskLimits || {};
    const maxOrder = Number(rl.maxOrderDollars ?? 10);
    const maxPos   = Number(rl.maxPositionDollars ?? 25);
    const passed = dollars <= maxOrder && dollars <= maxPos;
    return {
      passed,
      notes: passed
        ? `$${dollars} order ≤ $${maxOrder} max-order and ≤ $${maxPos} max-per-position.`
        : `$${dollars} exceeds a risk limit (max-order $${maxOrder}, max-per-position $${maxPos}).`,
    };
  }

  /** Turn a loose imported idea ({symbol, side, dollars, reasoning}) into a full recommendation. */
  function normalizeImported(raw, riskLimits) {
    const symbol = String(raw.symbol || '').toUpperCase().trim();
    if (!symbol) return null;
    const dollars = raw.dollars != null ? Number(raw.dollars) : null;
    const qty     = raw.qty != null ? Number(raw.qty) : null;
    return {
      id:         Utils.uuid(),
      symbol,
      side:       String(raw.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy',
      orderType:  raw.orderType === 'limit' ? 'limit' : 'market',
      dollars:    dollars != null && !isNaN(dollars) ? dollars : (qty == null ? Number(riskLimits?.maxOrderDollars ?? 10) : null),
      qty:        qty != null && !isNaN(qty) ? qty : null,
      limitPrice: raw.limitPrice != null ? Number(raw.limitPrice) : null,
      reasoning:  String(raw.reasoning || '').trim() || 'Imported idea.',
      guardrail:  raw.guardrail && typeof raw.guardrail.passed === 'boolean'
                    ? raw.guardrail
                    : guardrail(dollars != null && !isNaN(dollars) ? dollars : Number(riskLimits?.maxOrderDollars ?? 10), riskLimits),
      createdAt:  Utils.nowISO(),
      decidedAt:  null,
      status:     'pending',
      source:     raw.source || 'claude-code',
    };
  }

  return { SCHEMA_VERSION, mcpCommand, sizeLabel, sampleDoc, claudeCodePrompt, guardrail, normalizeImported };
})();
