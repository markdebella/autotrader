# Deploying the AutoTrader backend (Google Cloud)

This stands up the hardened backend from [`SECURITY.md`](../SECURITY.md): Alpaca keys live
**only** in Secret Manager, read by a Cloud Run service that the dashboard calls. You can do
all of this from a **browser** using **Cloud Shell** — nothing is installed on your computer.

> Prerequisite: a GCP **billing account** must be linked to the project (free tier won't
> charge at this scale, but it must be on file). Use the **same GCP project** as your OAuth
> client.

## 0. Open Cloud Shell
Go to <https://console.cloud.google.com>, pick your project, and click the **terminal icon**
(`>_`, top right) to open Cloud Shell. Then set your variables (edit the values).

> Use your project **ID**, not its display name — IDs are globally unique and often carry a
> numeric suffix (display name "AutoTrader" → ID "autotrader-497920"). Find it with
> `gcloud projects list` (the PROJECT_ID column) or the console project picker.

```bash
export PROJECT_ID="autotrader-497920"     # ← real project ID, not just "autotrader"
export REGION="us-west1"
export OWNER_EMAIL="markdebella@gmail.com"          # the Google account you sign into the app with
export OAUTH_CLIENT_ID="686821485002-b7in6d56hfqc5bgajnpisf1432urrr93.apps.googleusercontent.com"
export ORIGINS="https://markdebella.github.io,http://localhost:8000,http://127.0.0.1:8000"
gcloud config set project "$PROJECT_ID"
```

## 1. Enable the APIs
```bash
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

## 2. Store the Alpaca **paper** keys as secrets
Typed at a hidden prompt so the key never lands in your shell history:
```bash
read -rs -p "Alpaca paper API key:    " K; printf "%s" "$K" | gcloud secrets create alpaca-paper-key    --data-file=-; unset K; echo
read -rs -p "Alpaca paper secret key: " S; printf "%s" "$S" | gcloud secrets create alpaca-paper-secret --data-file=-; unset S; echo

# OPTIONAL and usually unnecessary — only if you want the in-app AI engine to call the paid
# Anthropic API directly. The free paths need NO key: the in-app "Generate ideas (rules)"
# button, or "Copy Claude Code prompt" which uses your Claude subscription. Most setups skip this.
read -rs -p "Anthropic API key (optional): " C; printf "%s" "$C" | gcloud secrets create claude-api-key --data-file=-; unset C; echo
```

## 3. Create a least-privilege service account for the service
```bash
gcloud iam service-accounts create autotrader-api --display-name="AutoTrader backend"
SA="autotrader-api@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant read access to ONLY these two secrets (nothing else):
gcloud secrets add-iam-policy-binding alpaca-paper-key    --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding alpaca-paper-secret --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"

# Only if you created the Claude key above:
gcloud secrets add-iam-policy-binding claude-api-key --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
```

## 4. Get the code and deploy to Cloud Run
```bash
git clone https://github.com/markdebella/autotrader.git
cd autotrader

gcloud run deploy autotrader-api \
  --source ./service \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances=0 --max-instances=2 \
  --set-env-vars "^;^GCP_PROJECT=${PROJECT_ID};OWNER_EMAIL=${OWNER_EMAIL};OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID};ALLOWED_ORIGINS=${ORIGINS};ALPACA_PAPER=true"
```
- `--allow-unauthenticated` lets your browser reach it; the **service itself** still requires
  your Google ID token + owner email on every data endpoint, so it's not open to others.
- `--min-instances=0` = scale to zero (free when idle). `--max-instances=2` caps runaway cost.
- The `^;^` prefix tells gcloud to split entries on `;` instead of `,` — needed because
  `ALLOWED_ORIGINS` contains commas (and `OWNER_EMAIL` contains an `@`).

When it finishes, note the **Service URL** it prints (e.g. `https://autotrader-api-xxxx.run.app`).

## 5. Quick checks
```bash
URL="https://autotrader-api-xxxx.run.app"   # paste your URL
curl "$URL/healthz"                          # → {"ok":true,"paper":true}
curl "$URL/api/portfolio"                    # → 401 (no token) — auth is working
```

## 6. Set a budget alert (peace of mind)
Console → **Billing → Budgets & alerts → Create budget** → scope to this project → amount
**$1** → email alert at 50%/90%/100%. You'll be emailed the instant anything costs a cent
(it shouldn't, at this scale).

## Next step (separate change)
Point the dashboard at this service and remove all key entry/storage from the browser:
put the Service URL in the frontend config, have the dashboard fetch `/api/portfolio` with
the Google ID token, and delete the Alpaca-keys section from Settings. That's the next
increment after this deploy succeeds.
