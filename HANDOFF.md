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

**VERIFIED 2026-05-30:** local sign-in works at `http://127.0.0.1:8000`. OAuth is no
longer a blocker.

Note: the app is signed into with `markdebella@gmail.com`; git commits use
`mark.debella@hmhco.com`. These are intentionally separate.

## Likely next step
Phase 1 — contextual portfolio education (explain the user's real positions/metrics in
plain English on the dashboard).

## Resuming the original terminal session
The verbatim conversation that produced all this lives under the `C:\git` directory.
To reopen it: in a terminal, `cd C:\git` then `claude --resume` and pick the session.
