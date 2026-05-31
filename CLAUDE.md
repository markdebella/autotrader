# AutoTrader — Project Guide

> **New session?** See `HANDOFF.md` for current status and any open blockers.

A **visual, read-only portfolio dashboard** for Alpaca Markets. The dashboard only
*reads* and *displays* data. All actual trading is performed via the **Alpaca MCP
server** in Claude Code (paper-trading mode by default) — never from this app's code.

## Tech stack

- **Static site**, no build step. Plain HTML/CSS/JS served as files.
- **Alpine.js 3** (via CDN) — reactivity and global stores.
- **Chart.js 4** (via CDN) — charts.
- **Google Identity Services + GAPI** — sign-in and Google Drive storage.
- Deployed to **GitHub Pages** (note the `.nojekyll` file). Repo: `markdebella/autotrader`.

There is **no `package.json`, bundler, transpiler, or test runner.** Don't add one
without asking — it would change the deployment model.

## Run / preview locally

It's static files, so serve the directory and open it in a browser:

```powershell
python -m http.server 8000      # then open http://localhost:8000
# or: npx serve
```

> **Do NOT use VS Code Live Server.** It injects a live-reload `<script>` into every HTML
> file it serves — including the `views/*.html` fragments this SPA fetches and renders via
> `x-html`. That injection corrupts the fragment and silently truncates the view (e.g. the
> dashboard renders only partway with no console error). Use `python -m http.server 8000`
> (or `npx serve`), which serve files verbatim. The view loader also strips the injected
> block as a safety net, but Live Server's injection isn't fully tameable — just avoid it.
> Trade-off: no auto-reload, so reload manually after edits.

Note: Google OAuth requires the origin to be an **authorized JavaScript origin** on
the OAuth client. `http://localhost:8000` must be registered in the Google Cloud
console for sign-in to work locally.

## Architecture

Scripts load in a fixed order (see `index.html`) because they rely on globals, not modules:

`config.js` → `utils.js` → `auth.js` → `drive.js` → `manifest.js` → `seed.js` → `alpaca.js` → `view-components.js` → `app.js`

- **`config.js`** — public config (`CONFIG`): OAuth client ID, Alpaca endpoints,
  default risk limits, watchlist, glossary. **No secrets** — safe to commit.
- **`js/app.js`** — Alpine stores (`auth`, `data`, `portfolio`, `ui`), `Router`,
  `Toast`, and the `App` boot sequence (`onSignedIn` → bootstrap Drive → load
  manifest/settings → init Alpaca → go to dashboard).
- **`js/auth.js`** — Google sign-in (GIS token client + GAPI).
- **`js/drive.js`** — all Google Drive I/O. Data lives in the user's own Drive under
  an `AutoTrader/` folder: `manifest.json` (trade index), `settings.json` (prefs +
  Alpaca API keys + risk limits), and one `trade-{uuid}.json` per trade.
- **`js/manifest.js`** — keeps the in-memory manifest in sync with Drive.
- **`js/alpaca.js`** — **read-only** Alpaca REST client (account, positions, orders,
  portfolio history, clock). Do **not** add order-placement calls here.
- **`js/view-components.js`** — Alpine components for views.
- **`views/*.html`** — `dashboard`, `analytics`, `education`, `settings`. Loaded
  on demand by the `ViewLoader` component (hash-based routing) and cached.

## Key conventions & guardrails

- **Keep `alpaca.js` read-only.** Trading goes through the Alpaca MCP server, not the
  browser app. Adding buy/sell/cancel calls here is out of scope.
- **No secrets in the repo.** Only the public OAuth client ID is committed.
- **Key custody is moving to the hardened model in [`SECURITY.md`](SECURITY.md)** —
  API keys belong **only** in Google Secret Manager, read by a backend service, **never in
  the browser, Drive, env vars, or the repo** (paper *and* live). The current
  keys-in-Drive/browser path is **legacy, to be removed** when the backend service lands.
  Do not add new key exposure (no env-var or local-file key storage) in the meantime.
- **Cache-busting:** `index.html` references assets with `?v=` query strings and
  `CONFIG.appVersion` (format `YYYY.MM.DD.NN`). Bump `appVersion` in `config.js` when
  shipping changes that must invalidate caches.
- **Vanilla globals, not ES modules.** New files must be added to the `<script>` list
  in `index.html` in dependency order. Expose functionality via a global object
  (e.g. `const Foo = (() => { ... })()`), matching the existing files.
- **Update `README.md` when features change.** (The README is currently minimal.)

## Git

- Default branch: `main`. `git push` is intentionally **not** auto-approved — pushing
  publishes to the live GitHub Pages site, so confirm before pushing.
