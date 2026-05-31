# AutoTrader Roadmap

A phased plan to grow AutoTrader from a read-only dashboard into a guarded,
semi-autonomous trading assistant. The guiding principle is **earn trust in stages**:
educate first, recommend-with-approval second, guarded autonomy last — and stay on
**paper trading** until a strategy is proven.

> **Design rule:** build every phase with the later phases in mind so we don't churn
> code later. Concretely: keep trade *execution* out of the browser and out of the
> LLM's hot path; the dashboard reads and displays, code executes within hard limits,
> and the LLM educates / analyzes / proposes.

---

## Architecture (target state)

```
┌─────────────────┐     reads      ┌──────────────────────┐
│  Dashboard      │ ─────────────► │  Alpaca (paper/live) │
│  (static, RO)   │                │  REST market + acct  │
└────────┬────────┘                └──────────▲───────────┘
         │ approve/deny                        │ places orders
         ▼                                     │ (within limits)
┌─────────────────┐   recommendations   ┌──────┴───────────┐
│  Google Drive   │ ◄────────────────── │  Execution svc   │  (Phase 3)
│  (data store)   │ ──────────────────► │  deterministic   │
└────────▲────────┘   settings/limits   └──────▲───────────┘
         │                                      │ signals / strategy
         │             analyzes & proposes      │
         └──────────────  Claude (LLM)  ─────────┘
```

- **Dashboard** — existing static site. Read-only. The "watch it work" surface.
- **Google Drive** — existing data store (`manifest.json`, `settings.json`,
  `trade-{uuid}.json`). We add `recommendations.json` and a kill-switch flag.
- **Claude (LLM)** — educator + analyst + proposer. Never the thing that pulls the
  trigger on a live order.
- **Execution service** — *new in Phase 3*. Small deterministic service (Python +
  `alpaca-py`) on **Google Cloud Run**, triggered by **Cloud Scheduler**, that places
  orders **only** within the hard risk limits. It is the **only** holder of the Alpaca
  keys, read at runtime from **Google Secret Manager**.

> **Key custody:** see [`SECURITY.md`](SECURITY.md). Decided 2026-05-30: API keys live
> only in Google Secret Manager and are never exposed to the browser, Drive, env vars, or
> the repo — applied to paper *and* live from the start. The dashboard becomes a pure
> viewer that reads data from the service; the current keys-in-Drive path is legacy.

---

## Phase 1 — Educate (read-only, zero risk)

**Goal:** make *you* smarter about markets. No money moves.

**Features**
- Contextual education: explain your *actual* portfolio in plain English
  (why a position is up/down, what RSI/P&L mean for *this* holding).
- "Explain this" affordance on dashboard metrics and positions.
- Grow the glossary in `config.js` into linked, searchable lessons (foundation
  already exists: `education` view + 23-term glossary).

**Touches:** `views/education.html`, `views/dashboard.html`, `view-components.js`,
`alpaca.js` (read-only data already present).

**Exit criteria:** you can read the dashboard and understand every number on it.

---

## Phase 2 — Recommend + approve (human-in-the-loop)

**Goal:** Claude proposes trades; **you** approve or deny each one. Nothing executes
without your tap. Still **paper mode**.

**Features**
- Scheduled Claude analysis writes `recommendations.json` to Drive: each item has
  `{ id, symbol, side, qty/dollars, reasoning, guardrailCheck, createdAt, status }`.
- New **Recommendations** feed in the dashboard: card per rec showing *what*, *why*,
  and which limits it respects, plus **Approve / Deny** buttons.
- On approve → trade is placed (initially you place it; later via Alpaca MCP) and
  logged as a `trade-{uuid}.json` with a link back to the recommendation.
- "What if I'd taken every rec" shadow-tracking vs. actual, to calibrate trust.

**Touches:** new `views/recommendations.html` + component, `drive.js`
(load/save recommendations), `manifest.js` (link recs ↔ trades), scheduling
(Claude `/schedule` routine or a cron job).

**Exit criteria:** the recommendations are good enough that you'd trust them — proven
on paper over several weeks.

---

## Phase 3 — Guarded autonomy (runs itself, inside a cage)

**Goal:** trade on your behalf automatically, but only within hard-coded limits.

**Features**
- **Deterministic execution service** (Python + `alpaca-py`, runs unattended on a
  timer — e.g. cloud function + scheduler, or a tiny always-on VM). Each run:
  check market clock → read positions/account → apply strategy → **enforce every risk
  limit** → place order (or do nothing). Defaults to doing nothing on any doubt.
- **Kill switch:** a flag in Drive `settings.json` the service checks every run, so
  you can halt everything instantly from your phone.
- LLM still does the analysis/strategy proposals; **code pulls the trigger.**
- Graduate from "approve every trade" → "approve the strategy + limits, review daily."
- The settings scaffold already exists: `settings.claude.autonomousMode` and
  `settings.claude.maxAutonomousDollars`.

**Touches:** new execution service (separate from the static site), hosting +
scheduling, Drive read/write of limits + kill switch, audit logging.

**Exit criteria — before ANY real money:** strategy is profitable on paper, all
guardrails verified with tests, kill switch confirmed working, and you start real
trading at miniscule size.

---

## Risk limits (the "strict guidelines")

Single source of truth: `config.js → defaultRiskLimits`. Editable in-app at
**Settings → Risk Limits** (persists to your Drive `settings.json` — no code change).
Defaults below are sized for a **~$100 starter account** using Alpaca **fractional
shares**:

| Limit | Default | Purpose |
|---|---|---|
| `accountBudget` | **$100** | Total capital allocated to the app |
| `maxOrderDollars` | **$10** | Hard cap on a single trade — keeps trades miniscule |
| `maxPositionDollars` | **$25** | Hard cap on total $ held in one stock |
| `maxPositionPct` | **25%** | ...or this % of budget, whichever is smaller |
| `dailyLossLimit` | **$10** | Halt trading for the day after this loss (10% of budget) |
| `maxTradesPerDay` | **3** | Low frequency; also stays within the PDT day-trade limit |

**Additional guardrails to enforce in the Phase 3 execution code:**
- **Kill switch** — Drive flag checked every run; halts all activity.
- **Trading-hours guard** — regular hours only at first (market clock already fetched).
- **PDT guard** — block the 4th day-trade in 5 business days while account < $25k.
- **Fail-safe default** — refuse any action that would breach a limit; doing nothing
  is always the safe fallback.
- **Dry-run logging** — log the intended action before acting, for a full audit trail.

> As the budget grows, raise the dollar limits in Settings → Risk Limits. The percent
> limits scale automatically with `accountBudget`.

---

## Guiding principles (so future phases don't cause churn)

1. **Execution is code, not LLM.** The LLM proposes; deterministic code disposes.
2. **Read/write separation.** Dashboard reads; only the execution service writes orders.
3. **Drive is the source of truth** for limits, settings, recs, and the kill switch —
   so every component (dashboard, LLM, service) reads the same config.
4. **Paper before live; small before large.** Always.
5. **Fail safe.** When in doubt, do nothing.
