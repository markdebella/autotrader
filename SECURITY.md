# AutoTrader — Security & Key Custody

> **Decision (2026-05-30):** Treat every API key as **vulnerable gold that must never be
> exposed** — not in the browser, not in Drive, not in environment variables, not in the
> repo, not on a laptop. Build the hardened design **from the start** (no "safe enough for
> paper" shortcut); paper and live keys get the same custody.

## Principle

A secret should live **only** where the thing that uses it runs, in a managed secret
store, reachable by **one least-privilege identity** and nothing else. People and web
pages never see it.

## Target architecture

```
Browser dashboard (any computer, Google sign-in)   ← holds NO keys
        │  reads portfolio, generates ideas, places (paper) orders
        │  (sends the owner's Google access token on every call)
        ▼
Backend service  (Google Cloud Run, Python)        ← the ONLY key holder
        │  fetches keys at runtime via its service account
        ▼
Google Secret Manager  (Alpaca + Claude keys)       ← IAM least-privilege, versioned, audit-logged
        │
        ▼
Alpaca API + Claude API  (read data, generate ideas, place orders within hard limits)
        │
        └─ writes trade records / portfolio snapshots → owner's Google Drive → dashboard reads
```

### Where each secret lives
| Secret | Home | Who can read it |
|---|---|---|
| Alpaca paper key/secret | Google Secret Manager | The backend service's service account only |
| Claude (Anthropic) API key | Google Secret Manager (`claude-api-key`) | Same service account only — used by the recommendation engine (optional; rules engine needs no key) |
| Alpaca **live** key/secret (Phase 3) | Google Secret Manager (separate secrets) | Same service account only; promoted by an explicit, deliberate step |
| Drive access for the service | A stored OAuth refresh token **in Secret Manager** | Same service account only |

The **dashboard holds nothing sensitive**. The **repo contains no secrets** (only the public
OAuth client ID, which is safe). No secret is ever written to an env var or local disk.

## Components

- **Frontend** — the existing static dashboard on GitHub Pages. Becomes a pure viewer +
  approver. It authenticates the user with Google and calls the backend; it never stores
  or sees Alpaca keys.
- **Backend service** — Google Cloud Run (Python). The only holder of the keys (read from
  Secret Manager at runtime). Responsibilities:
  - **Read API** (live): authenticated read-only endpoints (account, positions, orders,
    clock) for the dashboard.
  - **Idea generation** (live): `POST /api/recommendations/generate` calls Claude with the
    key in Secret Manager, falling back to a deterministic rules engine if Claude is down.
  - **Order placement** (live, Phase 2): `POST /api/orders` re-checks the risk limits and
    places a **paper** order when the owner approves one in the app.
  - **Executor** (Phase 3): the same path on a Cloud Scheduler trigger — applies strategy
    **within hard risk limits**, checks the kill switch, writes an auditable trade record.
- **Google Secret Manager** — stores the keys (`alpaca-paper-key`, `alpaca-paper-secret`,
  `claude-api-key`); access via a dedicated service account with only
  `roles/secretmanager.secretAccessor` on the specific secrets. Every access is logged.
- **Auth (dashboard → service)** — the dashboard sends the owner's **Google access token**.
  The service verifies it via Google's `tokeninfo` endpoint and checks the audience
  (this app's OAuth client) + the email is the allowed owner, so only the owner can call it.
  (Access token, not ID token, because the ID-token/One Tap flow doesn't work on
  `http://localhost` during development.)
- **Google Drive** — unchanged role: non-secret app data (settings, recommendations,
  trade log, portfolio snapshots). Portable + free; the dashboard reads it after sign-in.

## Why this meets the requirements
- **Portable** — open the dashboard on any computer, sign in with Google; the cloud
  service serves your data. Execution is cloud-side, independent of any laptop.
- **Secure** — keys sit in a purpose-built store behind IAM least-privilege with audit
  logs; they are never in the browser, env vars, Drive, or the repo. A compromised browser
  cannot read a key or place a trade on its own.
- **Free** — GitHub Pages (frontend) + GCP always-free tier (Secret Manager, Cloud Run,
  Cloud Scheduler) on the GCP project already created for OAuth. A billing account must be
  on file for GCP, but personal-scale usage stays within the free tier ($0).

## Build order

1. **Secret Manager** — create `alpaca-paper-key` / `alpaca-paper-secret`; create a
   service account with `secretAccessor` on just those; enable the needed APIs.
2. **Backend read service** — Cloud Run (Python): verify the owner's Google ID token, read
   keys from Secret Manager, expose read-only Alpaca endpoints. CORS-allow the Pages origin
   and `http://localhost:8000`.
3. **Repoint the dashboard** — read portfolio data from the service instead of calling
   Alpaca directly; **remove all key entry/storage from the browser** (Settings no longer
   takes API keys; keys are provisioned into Secret Manager out-of-band).
4. **Executor (Phase 3)** — scheduled Cloud Run job: strategy → enforce every risk limit →
   kill-switch check → place order → write trade record to Drive. Defaults to doing nothing.
5. **Live keys** — added as separate Secret Manager secrets via a deliberate promotion
   step, with extra confirmation; same custody; never in the browser.

## Status (2026-05-31)
Steps 1–3 are **done**: Secret Manager holds the Alpaca paper keys and `claude-api-key`;
the Cloud Run backend serves read-only portfolio data, generates ideas (Claude + rules
fallback), and places paper orders on approval; the browser no longer takes or stores any
keys (the boot sequence scrubs any legacy keys lingering in Drive `settings.json`). Step 4
(scheduled executor) and step 5 (live keys) remain. Standing rule: never reintroduce key
exposure — no env-var or local-file key storage anywhere.
