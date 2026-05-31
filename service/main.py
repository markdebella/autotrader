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


def _claude_recommendations(summary, risk_limits, account):
    """Ask Claude for up to 5 small starter ideas as strict JSON. Key from Secret Manager."""
    api_key = _secret("claude-api-key")
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    system = (
        "You are a cautious trading assistant for a SMALL PAPER (simulated) account. Propose at most 5 "
        "small starter trade ideas. Education-first; this is NOT financial advice. Prefer buys of watchlist "
        "names on pullbacks; only suggest a sell for a symbol the account already holds. Each idea's dollars "
        f"must be <= {max_order:.0f} (the max-order limit). Return ONLY a JSON array (no prose, no code fence), "
        'each item: {"symbol": str, "side": "buy"|"sell", "dollars": number, "reasoning": str (1-2 plain sentences)}.'
    )
    user = json.dumps({"riskLimits": risk_limits, "account": account, "marketData": summary})
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
        return {"engine": "claude", "recommendations": _claude_recommendations(summary, risk_limits, account)}
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
