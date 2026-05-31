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

  return { SCHEMA_VERSION, mcpCommand, sizeLabel, sampleDoc };
})();
