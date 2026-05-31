/**
 * recommendations.js — Phase 2 (Recommend + Approve) helpers
 *
 * A "recommendation" is a trade idea for the user to approve or deny. Ideas are generated
 * by the backend service (AI via Claude, or the deterministic rules engine as a fallback)
 * and saved to the user's Drive (recommendations.json). When the user approves and places
 * an idea, the backend executes the PAPER order via Alpaca REST — the browser never holds
 * Alpaca/Claude keys and never places orders itself (see SECURITY.md / ROADMAP.md).
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
 *     createdAt, decidedAt, status: 'pending'|'approved'|'executed'|'denied',
 *     source: 'claude'|'rules'|'sample',
 *     order: { id, submittedAt } | null,  // set once placed
 *     tradeId: string | null              // id of the logged trade-{id}.json (links rec ↔ trade)
 *   }
 */

const Recs = (() => {
  const SCHEMA_VERSION = 1;

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

  /** Risk-limit check for an idea (mirrors the backend guardrail; backend is authoritative). */
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

  return { SCHEMA_VERSION, sizeLabel, sampleDoc, guardrail };
})();
