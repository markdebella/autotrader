# Session Handoff — current status

Short-lived working notes so a fresh Claude session (opened with `autotrader` as the
workspace root) has full context. Delete or trim once these items are resolved.

## What's been set up
- **Claude Code config:** `CLAUDE.md` (architecture + guardrails) and
  `.claude/settings.json` (allowlist; `git push` stays manual).
- **Roadmap:** `ROADMAP.md` — phases 1–3 (educate → recommend+approve → guarded
  autonomy). Build with later phases in mind; execution stays in deterministic code,
  not the LLM hot path. Paper-trading first.
- **Risk limits:** sized for a ~$100 account in `config.js → defaultRiskLimits`
  (`accountBudget` 100, `maxOrderDollars` 10, `maxPositionDollars` 25,
  `maxPositionPct` 25, `dailyLossLimit` 10, `maxTradesPerDay` 3). Editable in-app at
  **Settings → Risk Limits** (persists to Drive `settings.json`).
- **VSCode:** `.vscode/` (extensions, settings with Live Server on **port 8000**,
  launch configs), `.gitignore`, `.editorconfig`. `editor.formatOnSave` is off on
  purpose — preserve the hand-aligned comment columns.

## OAuth — new GCP project created (pending local sign-in test)
The original client ID belonged to the **MigraineTracker** GCP project (number
`155253754677`), which is why it didn't fit here. On 2026-05-30 we created a fresh
GCP project for AutoTrader under `markdebella@gmail.com` and swapped in its new
client ID: `686821485002-...` (see [config.js](config.js#L4)).

New project setup:
- **Google Drive API** enabled.
- **OAuth consent screen:** External, in "Testing" status, scope `drive.file`,
  `markdebella@gmail.com` added as a test user.
- **Web OAuth client** with Authorized JavaScript origins (no redirect URIs — GIS
  popup flow): `http://localhost:8000`, `http://127.0.0.1:8000`,
  `https://markdebella.github.io`. (Origins are scheme+host+port only — no path.)

**VERIFIED:** sign-in works. Develop locally on `http://localhost:8000` (required for
Google One Tap) served via `python -m http.server 8000` — **not** Live Server (it
injects a reload `<script>` that corrupts the fetched `views/*.html` fragments).

Note: the app is signed into with `markdebella@gmail.com`; git commits use
`mark.debella@hmhco.com`. These are intentionally separate.

## Backend (Cloud Run) — live
`autotrader-api` in region `us-west1`, project `autotrader-497920`. Holds the Alpaca
paper keys in **Secret Manager**; serves read-only `/api/portfolio` and
`/api/recommendations/generate`. The browser never holds keys. `CONFIG.apiBaseUrl` in
[config.js](config.js#L10) points at it.

> **Redeploy gotcha:** redeploy with every env var hard-coded — a fresh Cloud Shell
> drops `$ORIGINS`/`$SA`, and `--set-env-vars` then wipes `ALLOWED_ORIGINS`, which 400s
> every CORS preflight and makes the dashboard fail with a misleading
> "...keys in Secret Manager" error. `ALLOWED_ORIGINS` must include
> `https://markdebella.github.io,http://localhost:8000,http://127.0.0.1:8000` (commas →
> pass env vars with the `^;^` delimiter).

## Phase status
- **Phase 1 (Educate): done** — ⓘ explain tooltips/modals on every metric + position,
  glossary, Learn section.
- **Phase 2 (Recommend + Approve): in progress** — Ideas tab with two free idea paths
  (rules engine; Claude Code prompt → Import JSON), Approve/Deny wired, Approve emits a
  copyable Alpaca-MCP command for Claude Code (paper mode).
- **Phase 3 (Guarded autonomy): planned** — scheduled deterministic executor.

## Likely next step
Smoke-test the full Ideas loop (Generate/Import → Approve → run MCP command in Claude
Code → Refresh dashboard), then build approve→executed-trade linkage and shadow-tracking.

## Resuming the original terminal session
The verbatim conversation that produced all this lives under the `C:\git` directory.
To reopen it: in a terminal, `cd C:\git` then `claude --resume` and pick the session.
