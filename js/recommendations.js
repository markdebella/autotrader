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
   * key) to generate AI trade ideas and write them straight to the user's Drive. The app
   * then reads recommendations.json and shows them in the Ideas feed.
   */
  function claudeCodePrompt(watchlist, riskLimits) {
    const rl = riskLimits || {};
    const list = (watchlist || []).join(', ');
    return [
      'Help me generate PAPER-trading ideas for my AutoTrader app and save them to my Google Drive.',
      '',
      `Watchlist: ${list}`,
      `Risk limits: max $${rl.maxOrderDollars ?? 10} per order, max $${rl.maxPositionDollars ?? 25} per position, max ${rl.maxTradesPerDay ?? 3} trades/day.`,
      '',
      '1. Analyze the watchlist (use the Alpaca MCP for quotes/history if available, otherwise your best judgment). Propose UP TO 5 small starter ideas. Education-first, not financial advice. Prefer buys on pullbacks; only suggest a sell for a symbol I already hold.',
      '',
      '2. Format each idea as exactly this JSON object (dollars must be <= the max-order limit):',
      '   { "id": "<uuid>", "symbol": "AAPL", "side": "buy"|"sell", "orderType": "market", "dollars": <number>, "qty": null, "limitPrice": null, "reasoning": "<1-2 plain sentences>", "guardrail": { "passed": true, "notes": "<how it fits my limits>" }, "createdAt": "<ISO timestamp now>", "decidedAt": null, "status": "pending", "source": "claude-code" }',
      '',
      '3. In my Google Drive, open AutoTrader/recommendations.json (create it if missing). KEEP any items whose status is "approved" or "denied"; drop the rest; put your new ideas first. Write the whole file as:',
      `   { "version": ${SCHEMA_VERSION}, "updatedAt": "<ISO timestamp now>", "recommendations": [ ...new ideas..., ...kept approved/denied... ] }`,
      '',
      'Then tell me how many ideas you wrote. I\'ll click Refresh in the app to see them.',
    ].join('\n');
  }

  return { SCHEMA_VERSION, mcpCommand, sizeLabel, sampleDoc, claudeCodePrompt };
})();
