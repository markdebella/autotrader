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

## OPEN BLOCKER — Google OAuth sign-in fails locally
Signing in throws *"Access blocked: Authorization Error … register the JavaScript
origin."* The OAuth client ID is in [config.js](config.js#L4)
(`155253754677-...`, project number `155253754677`).

Two things to resolve:
1. **Register authorized JavaScript origins** on that OAuth client in Google Cloud
   Console → APIs & Services → Credentials:
   - `http://localhost:8000` and `http://127.0.0.1:8000` (local Live Server)
   - `https://markdebella.github.io` (live GitHub Pages site)
   (Origins are scheme+host+port only — no path.)
2. **Can't find the project in the console.** The error says "register origin" (not
   "invalid client"), so the project DOES exist — almost certainly the Cloud Console
   is signed into the **wrong Google account** (work `mark.debella@hmhco.com` instead
   of the app owner `markdebella@gmail.com`). Switch accounts, then use the project
   picker → "ALL" tab. If still not visible, create a fresh GCP project + OAuth client
   and replace the ID in `config.js`.

Note: the app is signed into with `markdebella@gmail.com`; git commits use
`mark.debella@hmhco.com`. These are intentionally separate.

## Likely next step
Phase 1 — contextual portfolio education (explain the user's real positions/metrics in
plain English on the dashboard).

## Resuming the original terminal session
The verbatim conversation that produced all this lives under the `C:\git` directory.
To reopen it: in a terminal, `cd C:\git` then `claude --resume` and pick the session.
