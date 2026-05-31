"""
AutoTrader backend — read-only portfolio API (Phase 3 hardened design).

Runs on Google Cloud Run. It is the ONLY holder of the Alpaca keys: it reads them
at runtime from Google Secret Manager (never from env vars baked at deploy, never from
the browser). The static dashboard calls this service with the owner's Google ID token;
the service verifies the token + owner email before returning anything.

Endpoints:
  GET /healthz        — unauthenticated health check (for Cloud Run)
  GET /api/portfolio  — owner-only; returns { account, positions, orders, clock }
                        as Alpaca's raw REST JSON (same shape the frontend already uses)

Later (Phase 3) this same service gains a scheduled executor that places orders within
hard risk limits; that's why it uses a real backend rather than the browser.
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
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")  # used when engine='gemini'

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
            "account":   _alpaca_get("/v2/account"),
            "positions": _alpaca_get("/v2/positions"),
            "orders":    _alpaca_get("/v2/orders", {"status": "open", "limit": 50, "direction": "desc"}),
            "clock":     _alpaca_get("/v2/clock"),
        }
    except requests.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Alpaca error: {e.response.status_code}")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Could not reach Alpaca")


# ── Recommendation generation (Phase 2) ─────────────────────────────────────────
# The backend generates trade ideas: it has the market data and (for the Gemini engine)
# the Gemini API key in Secret Manager. The browser triggers this and saves the result to
# the user's Drive — neither the Alpaca nor the Gemini key ever touches the browser.

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
    """Compact per-symbol stats for the rules engine and the Gemini prompt."""
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


def _gemini_recommendations(summary, risk_limits, account):
    """Ask Google Gemini for up to 5 small starter ideas as strict JSON. Key from Secret Manager.

    Uses the AI Studio Gemini API (generativelanguage.googleapis.com) with an API key
    created under the owner's Google account — free tier, no third-party provider.
    """
    api_key = _secret("gemini-api-key")
    max_order = float(risk_limits.get("maxOrderDollars", 10) or 10)
    system = (
        "You are a cautious trading assistant for a SMALL PAPER (simulated) account. Propose at most 5 "
        "small starter trade ideas. Education-first; this is NOT financial advice. Prefer buys of watchlist "
        "names on pullbacks; only suggest a sell for a symbol the account already holds. Each idea's dollars "
        f"must be <= {max_order:.0f} (the max-order limit). Return ONLY a JSON array, "
        'each item: {"symbol": str, "side": "buy"|"sell", "dollars": number, "reasoning": str (1-2 plain sentences)}.'
    )
    user = json.dumps({"riskLimits": risk_limits, "account": account, "marketData": summary})
    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        params={"key": api_key},
        json={
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "maxOutputTokens": 1024,
                "temperature": 0.6,
                "responseMimeType": "application/json",
            },
        },
        timeout=40,
    )
    resp.raise_for_status()
    payload = resp.json()
    candidate = (payload.get("candidates") or [{}])[0]
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    ideas = _extract_json_array(text)
    recs = []
    for idea in ideas[:5]:
        sym = str(idea.get("symbol", "")).upper().strip()
        if not sym:
            continue
        dollars = float(idea.get("dollars") or max_order)
        recs.append(_make_rec(sym, idea.get("side", "buy"), dollars,
                              str(idea.get("reasoning", "")).strip(), risk_limits, "gemini"))
    return recs


@app.post("/api/recommendations/generate")
async def generate_recommendations(request: Request):
    _require_owner(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    # Any non-'rules' value means the AI engine (handles legacy 'claude' too).
    engine      = "rules" if str(body.get("engine", "gemini")).lower() == "rules" else "gemini"
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

    # Gemini engine — degrade gracefully to rules if the key is missing or the call fails.
    try:
        account = {}
        try:
            acct = _alpaca_get("/v2/account")
            account = {"buying_power": acct.get("buying_power"), "portfolio_value": acct.get("portfolio_value")}
        except requests.RequestException:
            pass
        return {"engine": "gemini", "recommendations": _gemini_recommendations(summary, risk_limits, account)}
    except Exception as e:
        return {
            "engine": "rules",
            "fallback": True,
            "reason": str(e)[:200],
            "recommendations": _rules_recommendations(summary, risk_limits),
        }
