"""
AutoTrader backend — portfolio API + idea generation + order execution (hardened design).

Runs on Google Cloud Run. It is the ONLY holder of the Alpaca and Claude keys: it reads
them at runtime from Google Secret Manager (never from env vars baked at deploy, never
from the browser). The static dashboard calls this service with the owner's Google access
token; the service verifies the token + owner email before doing anything.

This is what makes AutoTrader portable: every secret lives in the cloud, configured once,
so the user can sign in on any computer and the dashboard, AI ideas, and execution all
work with nothing installed or configured locally.

Endpoints:
  GET  /healthz                       — unauthenticated health check (for Cloud Run)
  GET  /api/portfolio                 — owner-only; { account, positions, orders, clock }
  POST /api/recommendations/generate  — owner-only; AI (Claude) ideas, rules fallback
  POST /api/orders                    — owner-only; place a paper order via Alpaca REST,
                                        after re-checking risk limits server-side

Order placement lives here (not in the browser) so the Alpaca keys never leave Secret
Manager. The browser only ever *asks* this service to act; it holds no keys and places
no orders itself. A scheduled guarded executor (Phase 3) will reuse this same path.
"""

import datetime
import functools
import json
import os
import uuid

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from google.cloud import secretmanager

# ── Config (set at deploy time; NONE of these are secrets) ──────────────────────
PROJECT_ID      = os.environ["GCP_PROJECT"]              # GCP project holding the secrets
OWNER_EMAIL     = os.environ["OWNER_EMAIL"].lower()      # only this Google account may call
OAUTH_CLIENT_ID = os.environ["OAUTH_CLIENT_ID"]          # audience the ID token must match
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
ALPACA_PAPER    = os.environ.get("ALPACA_PAPER", "true").lower() == "true"

ALPACA_BASE = "https://paper-api.alpaca.markets" if ALPACA_PAPER else "https://api.alpaca.markets"
ALPACA_DATA_BASE = "https://data.alpaca.markets"
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")  # used when engine='claude'
# Service account Cloud Scheduler uses to call the scheduled-run endpoint (Stage B). The
# scheduled endpoint accepts an OIDC token from ONLY this identity. Empty = scheduling off.
CRON_SA_EMAIL = os.environ.get("CRON_SA_EMAIL", "").lower()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# ── Secrets (fetched from Secret Manager once per instance, then cached) ────────
@functools.lru_cache(maxsize=8)
def _secret(name: str) -> str:
    client = secretmanager.SecretManagerServiceClient()
    path = f"projects/{PROJECT_ID}/secrets/{name}/versions/latest"
    return client.access_secret_version(name=path).payload.data.decode("utf-8")


# ── Firestore: autopilot config + run log (Stage B) ─────────────────────────────
# Stores the autopilot config (so the unattended scheduler can read it without a browser)
# and a log of each scheduled run. Free-tier usage. Lazily initialized so the rest of the
# service works even before Firestore is enabled.
_AUTOPILOT_DEFAULTS = {
    "enabled":    False,     # master switch for SCHEDULED trading
    "killSwitch": False,     # halts everything when true
    "engine":     "ai",      # 'ai' | 'rules'
    "cadence":    "daily",   # informational; the real schedule is the Cloud Scheduler job
    "watchlist":  [],
    "themes":     [],
    "riskLimits": {},
}


@functools.lru_cache(maxsize=1)
def _firestore():
    from google.cloud import firestore  # imported lazily; optional dependency at runtime
    return firestore.Client(project=PROJECT_ID)


def _autopilot_doc():
    return _firestore().collection("autotrader").document("autopilot")


def _get_autopilot_config() -> dict:
    snap = _autopilot_doc().get()
    cfg = dict(_AUTOPILOT_DEFAULTS)
    if snap.exists:
        cfg.update({k: v for k, v in (snap.to_dict() or {}).items() if v is not None})
    return cfg


def _save_autopilot_config(patch: dict) -> dict:
    allowed = {"enabled", "killSwitch", "engine", "cadence", "watchlist", "themes", "riskLimits"}
    clean = {k: patch[k] for k in allowed if k in patch}
    if clean.get("engine") not in (None, "ai", "rules"):
        clean["engine"] = "ai"
    _autopilot_doc().set(clean, merge=True)
    return _get_autopilot_config()


def _log_autopilot_run(summary: dict) -> None:
    from google.cloud import firestore
    doc = {**summary, "ts": firestore.SERVER_TIMESTAMP, "trigger": summary.get("trigger", "scheduled")}
    # Keep the log compact — store action essentials, not the full Alpaca order objects.
    doc["actions"] = [{k: a.get(k) for k in ("symbol", "side", "dollars", "qty", "status", "reason")}
                      for a in (summary.get("actions") or [])][:25]
    _firestore().collection("autotrader").document("autopilot").collection("runs").add(doc)


def _recent_autopilot_runs(limit: int = 20) -> list:
    from google.cloud import firestore
    q = (_firestore().collection("autotrader").document("autopilot").collection("runs")
         .order_by("ts", direction=firestore.Query.DESCENDING).limit(limit))
    out = []
    for d in q.stream():
        r = d.to_dict() or {}
        ts = r.get("ts")
        r["ts"] = ts.isoformat() if hasattr(ts, "isoformat") else None
        out.append(r)
    return out


def _alpaca_get(path: str, params: dict | None = None):
    headers = {
        "APCA-API-KEY-ID":     _secret("alpaca-paper-key"),
        "APCA-API-SECRET-KEY": _secret("alpaca-paper-secret"),
    }
    resp = requests.get(ALPACA_BASE + path, headers=headers, params=params, timeout=10)
    resp.raise_for_status()
    return resp.json()


def _alpaca_data_get(path: str, params: dict | None = None):
    headers = {
        "APCA-API-KEY-ID":     _secret("alpaca-paper-key"),
        "APCA-API-SECRET-KEY": _secret("alpaca-paper-secret"),
    }
    resp = requests.get(ALPACA_DATA_BASE + path, headers=headers, params=params, timeout=15)
    resp.raise_for_status()
    return resp.json()


def _alpaca_post(path: str, body: dict):
    headers = {
        "APCA-API-KEY-ID":     _secret("alpaca-paper-key"),
        "APCA-API-SECRET-KEY": _secret("alpaca-paper-secret"),
        "Content-Type":        "application/json",
    }
    resp = requests.post(ALPACA_BASE + path, headers=headers, json=body, timeout=15)
    resp.raise_for_status()
    return resp.json()


# ── Auth: only the signed-in owner may call ─────────────────────────────────────
TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"


def _require_owner(request: Request) -> None:
    """Verify the caller's Google OAuth **access token** via Google's tokeninfo endpoint.

    We verify an access token (not an ID token) because Google's ID-token / One Tap flow
    doesn't work on http://localhost during development, whereas the access token the
    dashboard already obtains works on both localhost and the live site. The token only
    proves identity (it's issued for this app, to the owner) — it carries no Alpaca
    credentials, which live solely in Secret Manager.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth.split(" ", 1)[1]
    try:
        resp = requests.get(TOKENINFO_URL, params={"access_token": token}, timeout=10)
    except requests.RequestException:
        raise HTTPException(status_code=503, detail="Auth check failed")
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    info = resp.json()
    email = (info.get("email") or "").lower()
    verified = str(info.get("email_verified", "")).lower() == "true"
    audience = info.get("aud") or info.get("azp")
    if not email or not verified or email != OWNER_EMAIL:
        raise HTTPException(status_code=403, detail="Not the owner")
    if audience != OAUTH_CLIENT_ID:
        raise HTTPException(status_code=403, detail="Token not issued for this app")


# ── Routes ──────────────────────────────────────────────────────────────────────
@app.get("/healthz")
def healthz():
    return {"ok": True, "paper": ALPACA_PAPER}


@app.get("/api/portfolio")
def portfolio(request: Request):
    _require_owner(request)
    try:
        return {
            "account":      _alpaca_get("/v2/account"),
            "positions":    _alpaca_get("/v2/positions"),
            "orders":       _alpaca_get("/v2/orders", {"status": "open", "limit": 50, "direction": "desc"}),
            # All recent orders (filled/canceled/open) so the dashboard can reconcile the
            # status + fill price of trades it logged (accepted → filled).
            "recentOrders": _alpaca_get("/v2/orders", {"status": "all", "limit": 100, "direction": "desc"}),
            "clock":        _alpaca_get("/v2/clock"),
        }
    except requests.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Alpaca error: {e.response.status_code}")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca")


@app.get("/api/portfolio/history")
def portfolio_history(request: Request, period: str = "1M", timeframe: str = "1D"):
    """Equity timeseries for the funds-over-time chart (Alpaca portfolio history)."""
    _require_owner(request)
    period = period if period in {"1D", "1W", "1M", "3M", "1A", "all"} else "1M"
    timeframe = timeframe if timeframe in {"1Min", "5Min", "15Min", "1H", "1D"} else "1D"
    try:
        return _alpaca_get("/v2/account/portfolio/history",
                           {"period": period, "timeframe": timeframe, "extended_hours": "false"})
    except requests.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Alpaca error: {e.response.status_code}")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca")


@app.get("/api/bars")
def bars(request: Request, symbols: str = "", days: int = 40):
    """Daily bars per symbol for the per-position price charts (free IEX feed)."""
    _require_owner(request)
    syms = [s.upper().strip() for s in symbols.split(",") if s.strip()][:30]
    if not syms:
        return {"bars": {}}
    days = max(5, min(int(days or 40), 400))
    start = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).strftime("%Y-%m-%d")
    try:
        data = _alpaca_data_get("/v2/stocks/bars", {
            "symbols": ",".join(syms), "timeframe": "1Day", "start": start, "feed": "iex", "limit": 10000,
        })
        return {"bars": data.get("bars", {}) or {}}
    except requests.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Alpaca data error: {e.response.status_code}")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca market data")


# ── Recommendation generation (Phase 2) ─────────────────────────────────────────
# The backend generates trade ideas: it has the market data and (for the Claude engine)
# the Claude API key in Secret Manager. The browser triggers this and saves the result to
# the user's Drive — neither the Alpaca nor the Claude key ever touches the browser.

def _recent_bars(symbols):
    """Daily bars for the last ~30 calendar days per symbol (free IEX feed)."""
    if not symbols:
        return {}
    start = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)).strftime("%Y-%m-%d")
    data = _alpaca_data_get("/v2/stocks/bars", {
        "symbols": ",".join(symbols),
        "timeframe": "1Day",
        "start": start,
        "feed": "iex",
        "limit": 10000,
    })
    return data.get("bars", {}) or {}


def _summarize(bars_by_symbol):
    """Compact per-symbol stats for the rules engine and the Claude prompt."""
    out = {}
    for sym, bars in bars_by_symbol.items():
        closes = [b.get("c") for b in (bars or []) if b.get("c") is not None][-10:]
        if len(closes) >= 3:
            out[sym] = {
                "last":  round(closes[-1], 2),
                "avg10": round(sum(closes) / len(closes), 2),
                "min10": round(min(closes), 2),
                "max10": round(max(closes), 2),
            }
    return out


def _guardrail(dollars, risk_limits):
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    max_pos   = float(risk_limits.get("maxPositionDollars", 25) or 25)
    passed = dollars <= max_order and dollars <= max_pos
    if passed:
        notes = f"${dollars:.0f} order ≤ ${max_order:.0f} max-order and ≤ ${max_pos:.0f} max-per-position."
    else:
        notes = f"${dollars:.0f} exceeds a risk limit (max-order ${max_order:.0f}, max-per-position ${max_pos:.0f})."
    return {"passed": passed, "notes": notes}


def _make_rec(symbol, side, dollars, reasoning, risk_limits, source):
    return {
        "id":         str(uuid.uuid4()),
        "symbol":     symbol,
        "side":       "sell" if str(side).lower() == "sell" else "buy",
        "orderType":  "market",
        "dollars":    round(float(dollars), 2),
        "qty":        None,
        "limitPrice": None,
        "reasoning":  reasoning,
        "guardrail":  _guardrail(float(dollars), risk_limits),
        "createdAt":  datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "decidedAt":  None,
        "status":     "pending",
        "source":     source,
    }


def _rules_recommendations(summary, risk_limits):
    """Deterministic 'buy the dip' starter ideas: symbols >=2% below their ~10-day average."""
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    recs = []
    for sym, s in summary.items():
        if s["avg10"] and s["last"] < s["avg10"] * 0.98:
            pct = (s["last"] - s["avg10"]) / s["avg10"] * 100
            recs.append(_make_rec(
                sym, "buy", max_order,
                f"{sym} is trading {abs(pct):.1f}% below its recent average (${s['avg10']:.2f} vs ${s['last']:.2f}) "
                f"— a modest pullback. A small starter buy fits a cautious, buy-the-dip, learn-by-doing approach.",
                risk_limits, "rules",
            ))
    recs.sort(key=lambda r: r["symbol"])
    return recs[:5]


def _extract_json_array(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


def _theme_line(themes):
    """Guidance sentence that steers the AI toward the user's focus areas without caging it."""
    themes = [str(t).strip() for t in (themes or []) if str(t).strip()][:12]
    if not themes:
        return ""
    return (" The user is especially bullish on these focus areas: " + "; ".join(themes) + ". "
            "Favor names in these areas and on the watchlist, but you MAY also propose other sound "
            "names you judge fit — use your own judgment within the limits.")


def _claude_recommendations(summary, risk_limits, account, themes=None):
    """Ask Claude for up to 5 small starter ideas as strict JSON. Key from Secret Manager."""
    api_key = _secret("claude-api-key")
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    system = (
        "You are a cautious trading assistant for a SMALL PAPER (simulated) account. Propose at most 5 "
        "small starter trade ideas. Education-first; this is NOT financial advice. Prefer buys on pullbacks; "
        "only suggest a sell for a symbol the account already holds. Each idea's dollars "
        f"must be <= {max_order:.0f} (the max-order limit)." + _theme_line(themes) +
        ' Return ONLY a JSON array (no prose, no code fence), '
        'each item: {"symbol": str, "side": "buy"|"sell", "dollars": number, "reasoning": str (1-2 plain sentences)}.'
    )
    user = json.dumps({"riskLimits": risk_limits, "account": account, "themes": themes or [], "marketData": summary})
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": CLAUDE_MODEL,
            "max_tokens": 1024,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}],
        },
        timeout=40,
    )
    resp.raise_for_status()
    payload = resp.json()
    text = "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")
    ideas = _extract_json_array(text)
    recs = []
    for idea in ideas[:5]:
        sym = str(idea.get("symbol", "")).upper().strip()
        if not sym:
            continue
        dollars = float(idea.get("dollars") or max_order)
        recs.append(_make_rec(sym, idea.get("side", "buy"), dollars,
                              str(idea.get("reasoning", "")).strip(), risk_limits, "claude"))
    return recs


@app.post("/api/recommendations/generate")
async def generate_recommendations(request: Request):
    _require_owner(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    engine      = "rules" if str(body.get("engine", "claude")).lower() == "rules" else "claude"
    watchlist   = [str(s).upper().strip() for s in (body.get("watchlist") or []) if str(s).strip()][:25]
    risk_limits = body.get("riskLimits") or {}
    themes      = body.get("themes") or []

    try:
        summary = _summarize(_recent_bars(watchlist))
    except requests.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Market-data error: {e.response.status_code}")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca market data")

    if engine == "rules":
        return {"engine": "rules", "recommendations": _rules_recommendations(summary, risk_limits)}

    # Claude engine — degrade gracefully to rules if the key is missing or the call fails.
    try:
        account = {}
        try:
            acct = _alpaca_get("/v2/account")
            account = {"buying_power": acct.get("buying_power"), "portfolio_value": acct.get("portfolio_value")}
        except requests.RequestException:
            pass
        return {"engine": "claude", "recommendations": _claude_recommendations(summary, risk_limits, account, themes)}
    except Exception as e:
        return {
            "engine": "rules",
            "fallback": True,
            "reason": str(e)[:200],
            "recommendations": _rules_recommendations(summary, risk_limits),
        }


# ── Order execution ───────────────────────────────────────────────────────────
# The browser sends an approved idea here; the backend re-checks the risk limits
# (never trusting the client) and places a PAPER order via Alpaca REST using the keys
# in Secret Manager. Dollar-sized orders use Alpaca "notional" market orders (fractional
# shares, time_in_force=day). This is the same execution path the Phase 3 scheduler reuses.

@app.post("/api/orders")
async def place_order(request: Request):
    _require_owner(request)
    if not ALPACA_PAPER:
        # Guard: live trading is intentionally not enabled from this endpoint yet.
        raise HTTPException(status_code=403, detail="Live trading is not enabled")
    try:
        body = await request.json()
    except Exception:
        body = {}

    symbol      = str(body.get("symbol", "")).upper().strip()
    side        = "sell" if str(body.get("side", "buy")).lower() == "sell" else "buy"
    order_type  = "limit" if str(body.get("orderType", "market")).lower() == "limit" else "market"
    risk_limits = body.get("riskLimits") or {}
    dollars     = body.get("dollars")
    qty         = body.get("qty")
    limit_price = body.get("limitPrice")

    if not symbol:
        raise HTTPException(status_code=400, detail="Missing symbol")
    if dollars is None and qty is None:
        raise HTTPException(status_code=400, detail="Specify a dollar amount or share quantity")

    # Authoritative server-side guardrail re-check on the dollar size.
    if dollars is not None:
        dollars = float(dollars)
        gr = _guardrail(dollars, risk_limits)
        if not gr["passed"]:
            raise HTTPException(status_code=422, detail="Order exceeds risk limits: " + gr["notes"])

    order: dict = {"symbol": symbol, "side": side, "type": order_type, "time_in_force": "day"}
    if order_type == "limit":
        # Alpaca notional orders must be market orders, so limit orders require a share qty.
        if qty is None:
            raise HTTPException(status_code=400, detail="Limit orders require a share quantity")
        order["qty"] = qty
        if limit_price is not None:
            order["limit_price"] = float(limit_price)
    elif dollars is not None:
        order["notional"] = round(dollars, 2)
    else:
        order["qty"] = qty

    try:
        return _alpaca_post("/v2/orders", order)
    except requests.HTTPError as e:
        msg = ""
        try:
            msg = (e.response.json() or {}).get("message", "")
        except Exception:
            msg = (e.response.text or "")[:200]
        raise HTTPException(status_code=502, detail=f"Alpaca rejected the order: {msg or e.response.status_code}")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca to place the order")


# ── Autonomous trading cycle (hybrid Phase 3, paper) ──────────────────────────
# Runs ONE trading cycle on demand: decide buys/sells (AI or rules), enforce every risk
# limit server-side, and place the paper orders. Same path a Cloud Scheduler will call
# later. Defaults to doing nothing on any doubt; a kill switch halts it entirely.

def _rules_autonomous(summary, risk_limits, positions):
    """Deterministic actions: buy watchlist dips; take profit / cut losses on holdings."""
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    actions = []
    for sym, s in summary.items():
        if s["avg10"] and s["last"] < s["avg10"] * 0.98:
            pct = (s["last"] - s["avg10"]) / s["avg10"] * 100
            actions.append({"symbol": sym, "side": "buy", "dollars": max_order,
                            "reasoning": f"{sym} is {abs(pct):.1f}% below its 10-day average — buy the dip."})
    for p in positions:
        try:
            plpc = float(p.get("unrealized_plpc") or 0) * 100
        except (TypeError, ValueError):
            continue
        sym, qty = p.get("symbol"), p.get("qty")
        if plpc >= 5:
            actions.append({"symbol": sym, "side": "sell", "qty": qty,
                            "reasoning": f"{sym} is up {plpc:.1f}% — take profit."})
        elif plpc <= -5:
            actions.append({"symbol": sym, "side": "sell", "qty": qty,
                            "reasoning": f"{sym} is down {abs(plpc):.1f}% — cut the loss."})
    return actions


def _claude_autonomous(summary, risk_limits, account, positions, themes=None):
    """Ask Claude to choose this cycle's actions as strict JSON. Key from Secret Manager."""
    api_key = _secret("claude-api-key")
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    held = [{"symbol": p.get("symbol"), "qty": p.get("qty"),
             "unrealized_plpc": p.get("unrealized_plpc"), "market_value": p.get("market_value")}
            for p in positions]
    system = (
        "You are a cautious AUTONOMOUS trader for a SMALL PAPER (simulated) account — education/demo, "
        "NOT financial advice. Decide this cycle's actions. You may BUY watchlist names (especially on "
        "pullbacks) and may SELL holdings to take profit or cut losses. Only SELL symbols currently held. "
        f"Each BUY's dollars must be <= {max_order:.0f}." + _theme_line(themes) +
        " Doing nothing (an empty array) is acceptable and often correct. Return ONLY a JSON array "
        '(no prose, no code fence); each item is {"symbol": str, "side": "buy"|"sell", '
        '"dollars": number (buys), "qty": number (sells), "reasoning": str (1 short sentence)}.'
    )
    user = json.dumps({"riskLimits": risk_limits, "account": account, "positions": held,
                       "themes": themes or [], "marketData": summary})
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={
            "model": CLAUDE_MODEL,
            "max_tokens": 1024,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user}],
        },
        timeout=40,
    )
    resp.raise_for_status()
    payload = resp.json()
    text = "".join(b.get("text", "") for b in payload.get("content", []) if b.get("type") == "text")
    out = []
    for idea in _extract_json_array(text):
        sym = str(idea.get("symbol", "")).upper().strip()
        if not sym:
            continue
        side = "sell" if str(idea.get("side", "buy")).lower() == "sell" else "buy"
        action = {"symbol": sym, "side": side, "reasoning": str(idea.get("reasoning", "")).strip()}
        if side == "buy":
            action["dollars"] = float(idea.get("dollars") or max_order)
        else:
            action["qty"] = idea.get("qty")
        out.append(action)
    return out


def _run_cycle(engine, risk_limits, watchlist, themes, kill_switch, trigger="manual"):
    """One paper trading cycle: decide (AI/rules), enforce every guardrail, place orders.
    Returns a summary dict. Shared by the on-demand endpoint and the scheduler (Stage B)."""
    engine      = "rules" if str(engine).lower() == "rules" else "ai"
    watchlist   = [str(s).upper().strip() for s in (watchlist or []) if str(s).strip()][:25]
    risk_limits = risk_limits or {}

    if kill_switch:
        return {"halted": True, "reason": "Kill switch is on — no trades placed.",
                "engine": engine, "trigger": trigger, "actions": [], "placedCount": 0}

    # Snapshot the account state.
    try:
        clock     = _alpaca_get("/v2/clock")
        account   = _alpaca_get("/v2/account")
        positions = _alpaca_get("/v2/positions")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca")

    # Daily-loss guard: halt if today's equity is down by the limit or more.
    try:
        equity, last_eq = float(account.get("equity") or 0), float(account.get("last_equity") or 0)
        daily_loss_limit = float(risk_limits.get("dailyLossLimit", 0) or 0)
        if daily_loss_limit and last_eq and (equity - last_eq) <= -daily_loss_limit:
            return {"halted": True, "engine": engine, "actions": [],
                    "reason": f"Daily loss limit reached (down ${last_eq - equity:.2f} ≥ ${daily_loss_limit:.0f})."}
    except (TypeError, ValueError):
        pass

    try:
        summary = _summarize(_recent_bars(watchlist))
    except requests.RequestException:
        summary = {}

    # Decide. AI is primary; degrade to rules if Claude is missing or errors.
    fallback = False
    if engine == "ai":
        try:
            acct_min = {"buying_power": account.get("buying_power"), "portfolio_value": account.get("portfolio_value")}
            proposed, used = _claude_autonomous(summary, risk_limits, acct_min, positions, themes), "ai"
        except Exception:
            proposed, used, fallback = _rules_autonomous(summary, risk_limits, positions), "rules", True
    else:
        proposed, used = _rules_autonomous(summary, risk_limits, positions), "rules"

    # Enforce guardrails, then place what survives.
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    max_pos   = float(risk_limits.get("maxPositionDollars", 25) or 25)
    max_trades = int(risk_limits.get("maxTradesPerDay", 3) or 3)
    pos_by_sym = {p.get("symbol"): p for p in positions}

    today = str(clock.get("timestamp") or "")[:10]
    try:
        recent = _alpaca_get("/v2/orders", {"status": "all", "limit": 200, "direction": "desc"})
        trades_today = sum(1 for o in recent if str(o.get("submitted_at") or "")[:10] == today)
    except requests.RequestException:
        trades_today = 0

    results = []
    placed = 0
    for a in proposed:
        sym  = str(a.get("symbol", "")).upper().strip()
        side = "sell" if str(a.get("side")).lower() == "sell" else "buy"
        why  = str(a.get("reasoning", "")).strip()
        if not sym:
            continue
        if trades_today + placed >= max_trades:
            results.append({"symbol": sym, "side": side, "status": "skipped",
                            "reason": f"Daily trade limit reached ({max_trades}/day)."})
            continue

        order = {"symbol": sym, "side": side, "type": "market", "time_in_force": "day"}
        if side == "buy":
            dollars = min(float(a.get("dollars") or max_order), max_order)
            held_val = 0.0
            try:
                held_val = float((pos_by_sym.get(sym) or {}).get("market_value") or 0)
            except (TypeError, ValueError):
                pass
            if held_val + dollars > max_pos + 0.01:
                results.append({"symbol": sym, "side": side, "dollars": dollars, "status": "skipped",
                                "reason": f"Would exceed ${max_pos:.0f} max-per-position (holding ${held_val:.2f})."})
                continue
            order["notional"] = round(dollars, 2)
            disp = {"dollars": dollars}
        else:
            held = pos_by_sym.get(sym)
            if not held:
                results.append({"symbol": sym, "side": side, "status": "skipped", "reason": "Not currently held."})
                continue
            try:
                want = float(a.get("qty") or held.get("qty"))
                qty  = min(want, float(held.get("qty")))
            except (TypeError, ValueError):
                results.append({"symbol": sym, "side": side, "status": "skipped", "reason": "Bad quantity."})
                continue
            order["qty"] = str(qty)
            disp = {"qty": qty}

        try:
            res = _alpaca_post("/v2/orders", order)
            placed += 1
            results.append({"symbol": sym, "side": side, **disp, "status": "placed",
                            "reason": why, "orderId": res.get("id"), "order": res})
        except requests.HTTPError as e:
            try:
                emsg = (e.response.json() or {}).get("message", "")
            except Exception:
                emsg = str(e.response.status_code)
            results.append({"symbol": sym, "side": side, **disp, "status": "error",
                            "reason": f"Alpaca rejected: {emsg}"})

    return {
        "engine": used,
        "fallback": fallback,
        "marketOpen": bool(clock.get("is_open")),
        "evaluated": len(proposed),
        "placedCount": placed,
        "actions": results,
        "trigger": trigger,
    }


# ── On-demand cycle (Stage A) + scheduled cycle (Stage B) ─────────────────────
@app.post("/api/autonomous/run")
async def autonomous_run(request: Request):
    _require_owner(request)
    if not ALPACA_PAPER:
        raise HTTPException(status_code=403, detail="Live trading is not enabled")
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return _run_cycle(body.get("engine", "ai"), body.get("riskLimits") or {},
                          body.get("watchlist") or [], body.get("themes") or [],
                          bool(body.get("killSwitch")), trigger="manual")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca")


def _require_cron(request: Request) -> None:
    """Authenticate the scheduler: accept a Google OIDC token from CRON_SA_EMAIL only."""
    if not CRON_SA_EMAIL:
        raise HTTPException(status_code=503, detail="Scheduling is not configured")
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth.split(" ", 1)[1]
    try:
        resp = requests.get(TOKENINFO_URL, params={"id_token": token}, timeout=10)
    except requests.RequestException:
        raise HTTPException(status_code=503, detail="Auth check failed")
    if resp.status_code != 200 or (resp.json().get("email") or "").lower() != CRON_SA_EMAIL:
        raise HTTPException(status_code=403, detail="Not the scheduler identity")


@app.post("/api/autopilot/scheduled-run")
async def autopilot_scheduled_run(request: Request):
    """Called by Cloud Scheduler (OIDC). Reads config from Firestore, runs a cycle if enabled,
    and writes a run-log entry. The owner never needs a browser open for this to work."""
    _require_cron(request)
    if not ALPACA_PAPER:
        raise HTTPException(status_code=403, detail="Live trading is not enabled")
    try:
        cfg = _get_autopilot_config()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Config unavailable: {str(e)[:120]}")

    if not cfg.get("enabled") or cfg.get("killSwitch"):
        summary = {"halted": True, "engine": cfg.get("engine", "ai"), "trigger": "scheduled",
                   "actions": [], "placedCount": 0,
                   "reason": "Autopilot is disabled." if not cfg.get("enabled") else "Kill switch is on."}
    else:
        try:
            summary = _run_cycle(cfg.get("engine", "ai"), cfg.get("riskLimits") or {},
                                 cfg.get("watchlist") or [], cfg.get("themes") or [],
                                 False, trigger="scheduled")
        except Exception as e:
            summary = {"error": str(e)[:200], "engine": cfg.get("engine", "ai"),
                       "trigger": "scheduled", "actions": [], "placedCount": 0}
    try:
        _log_autopilot_run(summary)
    except Exception as e:
        print("autopilot run-log write failed:", e)
    return summary


@app.get("/api/autopilot/config")
def autopilot_config_get(request: Request):
    _require_owner(request)
    try:
        return _get_autopilot_config()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Firestore not ready: {str(e)[:120]}")


@app.put("/api/autopilot/config")
async def autopilot_config_put(request: Request):
    _require_owner(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return _save_autopilot_config(body)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Firestore not ready: {str(e)[:120]}")


@app.get("/api/autopilot/runs")
def autopilot_runs_get(request: Request):
    _require_owner(request)
    try:
        return {"runs": _recent_autopilot_runs(20)}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Firestore not ready: {str(e)[:120]}")
