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
from google.cloud import secretmanager

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
