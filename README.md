# AutoTrader

A visual, **read-only** portfolio dashboard for [Alpaca Markets](https://alpaca.markets),
with an education-first path toward a guarded, semi-autonomous trading assistant. The
dashboard only *reads and displays* data — **all order placement happens through the
Alpaca MCP server in Claude Code** (paper trading by default), never from this app.

Live site: <https://markdebella.github.io/autotrader/>

## How it works

- **Static site** — plain HTML/CSS/JS, no build step. Alpine.js + Chart.js via CDN.
- **Your data lives in your Google Drive** — settings (incl. Alpaca API keys), trade
  history, and recommendations are stored in an `AutoTrader/` folder in *your* Drive.
  Nothing is sent to any server we control.
- **Sign in with Google** to load your data; **enter Alpaca API keys** in Settings to
  see your portfolio.

## Views

- **Dashboard** — portfolio value, P&L, buying power, positions, orders, and market
  status. Every number has an **“Explain” (ⓘ)** affordance: hover for a quick definition,
  click for a plain-English explanation grounded in your real data, with links into the
  glossary.
- **Ideas** *(Recommendations)* — trade ideas for you to **Approve** or **Deny**. Nothing
  trades automatically. Approving records your decision and gives you a command to run in
  Claude Code, which places the order via the Alpaca MCP server (paper mode by default).
  Each idea shows how it fits within your risk limits.
- **Analytics** — portfolio history and trade stats (charts expand in a later phase).
- **Learn** — MCP setup guide, a searchable glossary, and how-to content.
- **Settings** — Alpaca connection, paper/live toggle, and editable **risk limits**
  (sized for a small starter account by default).

## Roadmap

See [`ROADMAP.md`](ROADMAP.md). Three phases, building trust in stages:

1. **Educate** *(done)* — understand every number on the dashboard.
2. **Recommend + approve** *(in progress)* — Claude proposes trades; you approve/deny;
   execution stays in Claude Code via MCP. Still paper trading.
3. **Guarded autonomy** *(later)* — a deterministic execution service places trades only
   within hard-coded risk limits, with a kill switch. Paper until proven.

Guiding rule: **execution is deterministic code, never the LLM**, and the dashboard never
places orders.

## Run locally

It's static files — serve the directory and open it in a browser:

```powershell
python -m http.server 8000      # then open http://localhost:8000
# or: npx serve
```

In VSCode, use the **Live Server** extension (preconfigured to port 8000). Note: Google
OAuth requires the origin (e.g. `http://localhost:8000`) to be a registered authorized
JavaScript origin on the OAuth client.

See [`CLAUDE.md`](CLAUDE.md) for architecture and contributor guardrails.
