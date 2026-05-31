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

import functools
import os

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport import requests as google_requests
from google.cloud import secretmanager
from google.oauth2 import id_token

# ── Config (set at deploy time; NONE of these are secrets) ──────────────────────
PROJECT_ID      = os.environ["GCP_PROJECT"]              # GCP project holding the secrets
OWNER_EMAIL     = os.environ["OWNER_EMAIL"].lower()      # only this Google account may call
OAUTH_CLIENT_ID = os.environ["OAUTH_CLIENT_ID"]          # audience the ID token must match
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
ALPACA_PAPER    = os.environ.get("ALPACA_PAPER", "true").lower() == "true"

ALPACA_BASE = "https://paper-api.alpaca.markets" if ALPACA_PAPER else "https://api.alpaca.markets"

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Authorization"],
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


# ── Auth: only the signed-in owner may call ─────────────────────────────────────
def _require_owner(request: Request) -> None:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth.split(" ", 1)[1]
    try:
        claims = id_token.verify_oauth2_token(token, google_requests.Request(), OAUTH_CLIENT_ID)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if not claims.get("email_verified") or claims.get("email", "").lower() != OWNER_EMAIL:
        raise HTTPException(status_code=403, detail="Not the owner")


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
