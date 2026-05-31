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
        │  reads portfolio (sends the owner's Google ID token)
        ▼
Backend service  (Google Cloud Run, Python)        ← the ONLY key holder
        │  fetches keys at runtime via its service account
        ▼
Google Secret Manager  (paper + live keys)          ← IAM least-privilege, versioned, audit-logged
        │
        ▼
Alpaca API   (read-only now; execute within hard limits in Phase 3)
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
- **Backend service** — Google Cloud Run (Python + `alpaca-py`). The only holder of the
  keys (read from Secret Manager at runtime). Responsibilities:
  - **Read API** (now): authenticated read-only endpoints (account, positions, orders,
    clock) for the dashboard.
  - **Executor** (Phase 3): on a Cloud Scheduler trigger, applies strategy **within hard
    risk limits**, checks the kill switch, places orders, writes an auditable trade record.
- **Google Secret Manager** — stores the keys; access via a dedicated service account with
  only `roles/secretmanager.secretAccessor` on the specific secrets. Every access is logged.
- **Auth (dashboard → service)** — the dashboard sends the owner's **Google ID token**
  (JWT). The service verifies the signature + audience and checks the email is the allowed
  owner, so only the owner can call it.
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

## Interim (until the service exists)
The current app still stores keys in Drive and uses them in the browser — this is **legacy,
to be removed** in step 3. While migrating: do **not** add any new key exposure (no env-var
or local-file storage). To place a paper trade in the meantime, prefer Alpaca's own paper
dashboard at <https://app.alpaca.markets> so no keys are handled locally.
