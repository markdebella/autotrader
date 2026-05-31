# AutoTrader — Project Guide

> **New session?** See `HANDOFF.md` for current status and any open blockers.

A **visual portfolio dashboard** for Alpaca Markets. The **browser holds no keys and
places no orders directly** — it reads data, generates AI ideas, and places (paper)
orders by calling a **backend service** (Google Cloud Run) that holds the Alpaca and
Claude keys in **Google Secret Manager**. Paper-trading mode by default. Everything
secret lives in the cloud, configured once, so the app works on any computer the owner
signs into — nothing installed or configured locally.

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
  risk limits + watchlist — **no API keys**), `recommendations.json` (trade ideas), and
  one `trade-{uuid}.json` per trade.
- **`js/api.js`** — client for the **backend service** (`CONFIG.apiBaseUrl`): read-only
  portfolio (`getPortfolio`), idea generation (`generateRecommendations`), and **paper
  order placement** (`placeOrder`). Authenticates with the owner's Google access token.
- **`js/alpaca.js`** — **read-only** Alpaca REST client, legacy/unused for live data now
  that portfolio comes from the backend. Do **not** add order-placement calls here — the
  browser never places orders; it asks `api.js`/the backend to.
- **`js/view-components.js`** — Alpine components for views.
- **`views/*.html`** — `dashboard`, `analytics`, `education`, `settings`. Loaded
  on demand by the `ViewLoader` component (hash-based routing) and cached.

## Key conventions & guardrails

- **The browser never places orders or holds keys.** Trading goes through the backend
  service's `POST /api/orders` (called via `js/api.js`), which re-checks risk limits and
  uses the Alpaca keys in Secret Manager. Keep `alpaca.js` read-only; don't add
  buy/sell/cancel calls to the browser. (The retired path was an Alpaca MCP server in
  Claude Code — superseded by the backend so the app stays portable and key-free.)
- **No secrets in the repo.** Only the public OAuth client ID is committed.
- **Hardened key custody (see [`SECURITY.md`](SECURITY.md)).** API keys — Alpaca **and**
  Claude — belong **only** in Google Secret Manager, read by the backend service, **never in
  the browser, Drive, env vars, or the repo** (paper *and* live). The backend service has
  landed; do not introduce any new key exposure (no env-var or local-file key storage).
- **Cache-busting:** `index.html` references assets with `?v=` query strings and
  `CONFIG.appVersion` (format `YYYY.MM.DD.NN`). Bump `appVersion` in `config.js` when
  shipping changes that must invalidate caches.
- **Vanilla globals, not ES modules.** New files must be added to the `<script>` list
  in `index.html` in dependency order. Expose functionality via a global object
  (e.g. `const Foo = (() => { ... })()`), matching the existing files.
- **Update `README.md` when features change.** (The README is currently minimal.)

## Git

- Default branch: `main`. `git push` is **auto-approved** (see `.claude/settings.json`
  allow list) per the owner's standing "commit + push without asking" preference — note
  this publishes to the live GitHub Pages site on every push. Destructive ops
  (`git reset --hard`, `git clean`, `rm -rf`) remain denied.
