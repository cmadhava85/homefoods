# LocalMeals — Infrastructure & launch guide

**Audience:** You (founder / solo eng) setting this up for the first time  
**Stack in this repo:** Next.js web · Fastify API · Worker · Cloud SQL Postgres · mocks for WA/payments locally  
**CI:** GitHub Actions (this guide)

Read this top to bottom once, then execute **Phase A → B → C**. Do not buy Shadowfax or IVR until MVP-1 is live on one pin.

---

## 0. What you need — by phase

| Capability | MVP-1 (now) | Later (MVP-2+) |
|------------|-------------|----------------|
| Hosting | **GCP Cloud Run** (web + api + worker) | same |
| Database | **Cloud SQL Postgres 16** (+ PostGIS when you need geo) | same |
| Object storage | **GCS** uploads bucket (menu/concern photos; local disk fallback in dev) | same |
| Secrets | **Secret Manager** | same |
| Cron | **Cloud Scheduler** (cut-off + EOD) | + Cloud Tasks |
| Customer / cook chat | **Meta WhatsApp Cloud API** (Business) | templates polish |
| Payments | **Razorpay** (UPI + Route/Easy Split for cook payout) | Cashfree alt |
| Maps | **Google Maps links only** (no Maps Platform bill required for dir URLs) | optional Distance Matrix |
| Delivery partner | **None** — SELF cook delivery | Shadowfax / Porter API |
| Voice IVR | **None** | Exotel / Twilio |
| CI/CD | **GitHub Actions** → Artifact Registry → Cloud Run | same |

**Cost mindset (solo launch):** See **[COST.md](./COST.md)**. Defaults: API/web scale-to-zero, worker min 1, `db-f1-micro`, Pub/Sub off, GCS lifecycle, Artifact prune. Staging idle: `./scripts/cost-sleep-staging.sh`.

---

## 1. Accounts & access checklist (do first)

Create these accounts before touching GCP:

1. **Google Cloud** — [console.cloud.google.com](https://console.cloud.google.com)  
   - Billing account linked  
   - One project: `localmeals-prod` (and optionally `localmeals-staging`)
2. **GitHub** — this repo pushed; Actions enabled  
3. **Meta Business** — [business.facebook.com](https://business.facebook.com)  
   - Business Manager + WhatsApp Business Account (WABA)  
4. **Razorpay** — [razorpay.com](https://razorpay.com)  
   - Test mode first; Route / linked accounts for cook payouts  
5. **Domain** (optional but recommended) — e.g. `api.localmeals.in`, `app.localmeals.in`  
6. **Delivery partner** — skip until SELF delivery is stable

Install CLIs on your Mac:

```bash
# Homebrew
brew install --cask google-cloud-sdk
brew install gh
```

**Auth must run in Terminal.app** (Cursor’s agent sandbox cannot open Chrome or write `~/.config/gcloud`):

```bash
cd ~/Documents/Development/localmeals
chmod +x scripts/gcp-bootstrap.sh
./scripts/gcp-bootstrap.sh
```

Or manually:

```bash
export BROWSER='open -a Google Chrome'
gcloud auth login
gcloud auth application-default login
gcloud config set project home-food-513806
gcloud config set compute/region asia-south1
```

---

## 2. Phase A — GCP project skeleton (half day)

**Prefer Terraform** (tracked, repeatable): see [`infra/terraform/README.md`](../infra/terraform/README.md).

```bash
cd infra/terraform
terraform init
# if resources already exist from gcloud:
./import-existing.sh
terraform plan && terraform apply
```

Manual `gcloud` steps below are the same shape Terraform encodes — use them only for one-off debugging.

---

### A1. Project & APIs

```bash
# Existing project (HomeFood / LocalMeals)
export PROJECT_ID=home-food-513806
export REGION=asia-south1          # Mumbai — closest for TN

# Or create a new one:
# gcloud projects create $PROJECT_ID --name="LocalMeals Prod"

gcloud config set project $PROJECT_ID
# Link billing in Console if prompted: https://console.cloud.google.com/billing?project=home-food-513806

gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  vpcaccess.googleapis.com \
  compute.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com
```

### A2. Artifact Registry (Docker images)

```bash
gcloud artifacts repositories create localmeals \
  --repository-format=docker \
  --location=$REGION \
  --description="LocalMeals images"

# Auth Docker to push
gcloud auth configure-docker ${REGION}-docker.pkg.dev
```

Image names you will use:

- `${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/api:TAG`
- `${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/worker:TAG`
- `${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/web:TAG`

### A3. Cloud SQL Postgres

```bash
gcloud sql instances create localmeals-pg \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=$REGION \
  --storage-size=10GB \
  --storage-auto-increase \
  --availability-type=ZONAL \
  --backup-start-time=18:00

gcloud sql databases create localmeals --instance=localmeals-pg

gcloud sql users create localmeals \
  --instance=localmeals-pg \
  --password='GENERATE_A_LONG_PASSWORD'
```

**PostGIS (when you need distance search):**

```bash
# Connect then: CREATE EXTENSION postgis;
gcloud sql connect localmeals-pg --user=localmeals --database=localmeals
```

For MVP-1 pin filter, PostGIS is optional (we store lat/lng as numbers).

**Connection string shape (Unix socket from Cloud Run):**

```text
postgres://localmeals:PASSWORD@/localmeals?host=/cloudsql/PROJECT:REGION:localmeals-pg
```

### A4. VPC connector (Cloud Run → Cloud SQL private)

```bash
gcloud compute networks vpc-access connectors create localmeals-conn \
  --region=$REGION \
  --network=default \
  --range=10.8.0.0/28 \
  --min-instances=2 \
  --max-instances=3
```

When deploying Cloud Run, attach:

- `--vpc-connector=localmeals-conn`
- `--add-cloudsql-instances=$PROJECT_ID:$REGION:localmeals-pg`

### A5. Secret Manager

Store real secrets here — never in GitHub plaintext long-term (Actions can sync into Secret Manager or inject at deploy).

```bash
echo -n 'postgres://...' | gcloud secrets create DATABASE_URL --data-file=-
echo -n 'your-verify-token' | gcloud secrets create WHATSAPP_VERIFY_TOKEN --data-file=-
echo -n '...' | gcloud secrets create WHATSAPP_ACCESS_TOKEN --data-file=-
echo -n '...' | gcloud secrets create WHATSAPP_APP_SECRET --data-file=-
echo -n '...' | gcloud secrets create WHATSAPP_PHONE_NUMBER_ID --data-file=-
echo -n '...' | gcloud secrets create RAZORPAY_KEY_ID --data-file=-
echo -n '...' | gcloud secrets create RAZORPAY_KEY_SECRET --data-file=-
echo -n '...' | gcloud secrets create RAZORPAY_WEBHOOK_SECRET --data-file=-
# Shared secret so Scheduler can call internal routes
echo -n "$(openssl rand -hex 32)" | gcloud secrets create INTERNAL_JOB_TOKEN --data-file=-
```

Grant Cloud Run runtime SA access:

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export RUNTIME_SA=${PROJECT_NUMBER}-compute@developer.gserviceaccount.com

for S in DATABASE_URL WHATSAPP_VERIFY_TOKEN WHATSAPP_ACCESS_TOKEN WHATSAPP_APP_SECRET \
         WHATSAPP_PHONE_NUMBER_ID RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET \
         RAZORPAY_WEBHOOK_SECRET INTERNAL_JOB_TOKEN; do
  gcloud secrets add-iam-policy-binding $S \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

### A6. Deploy services (manual first time)

Build locally once to prove images (or rely on GitHub Actions in §5):

```bash
# From repo root — after Dockerfiles are production-ready
docker build -f apps/api/Dockerfile -t ${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/api:manual .
docker push ${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/api:manual
# repeat for worker + web
```

```bash
gcloud run deploy localmeals-api \
  --image=${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/api:manual \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --vpc-connector=localmeals-conn \
  --add-cloudsql-instances=$PROJECT_ID:$REGION:localmeals-pg \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,\
WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,\
WHATSAPP_ACCESS_TOKEN=WHATSAPP_ACCESS_TOKEN:latest,\
WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest,\
WHATSAPP_PHONE_NUMBER_ID=WHATSAPP_PHONE_NUMBER_ID:latest,\
RAZORPAY_KEY_ID=RAZORPAY_KEY_ID:latest,\
RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,\
RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest,\
INTERNAL_JOB_TOKEN=INTERNAL_JOB_TOKEN:latest \
  --set-env-vars=MOCK_WHATSAPP=false,MOCK_PAYMENTS=false,NODE_ENV=production,\
LUNCH_CUTOFF_HOUR=8,LUNCH_CUTOFF_MINUTE=0

# Worker — same secrets; no public traffic needed
gcloud run deploy localmeals-worker \
  --image=${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/worker:manual \
  --region=$REGION \
  --vpc-connector=localmeals-conn \
  --add-cloudsql-instances=$PROJECT_ID:$REGION:localmeals-pg \
  --no-allow-unauthenticated \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest,... \
  --set-env-vars=MOCK_WHATSAPP=false,ENABLE_AUTO_CUTOFF=false,API_INTERNAL_URL=https://API_URL

# Web
gcloud run deploy localmeals-web \
  --image=${REGION}-docker.pkg.dev/$PROJECT_ID/localmeals/web:manual \
  --region=$REGION \
  --allow-unauthenticated \
  --set-env-vars=NEXT_PUBLIC_API_URL=https://YOUR_API_URL
```

Run migrations once (Cloud Run Job or local with Cloud SQL Auth Proxy):

```bash
# Local proxy approach
cloud-sql-proxy $PROJECT_ID:$REGION:localmeals-pg --port=5433
DATABASE_URL=postgres://localmeals:PASSWORD@127.0.0.1:5433/localmeals npm run db:migrate
DATABASE_URL=... npm run db:seed   # staging only
```

### A7. Cloud Scheduler (cut-off + EOD)

```bash
export API_URL=https://localmeals-api-xxxxx-as.a.run.app
export JOB_TOKEN=... # same as INTERNAL_JOB_TOKEN

# Lunch cut-off — Asia/Kolkata. Start with a fixed time; per-cook times are enforced in API.
gcloud scheduler jobs create http localmeals-lunch-cutoff \
  --location=$REGION \
  --schedule="0 8 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="${API_URL}/internal/cutoffs/LUNCH" \
  --http-method=POST \
  --headers="Content-Type=application/json,X-Internal-Token=${JOB_TOKEN}" \
  --message-body='{"force":false}'

gcloud scheduler jobs create http localmeals-eod \
  --location=$REGION \
  --schedule="0 18 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="${API_URL}/internal/settlements/eod" \
  --http-method=POST \
  --headers="Content-Type=application/json,X-Internal-Token=${JOB_TOKEN}" \
  --message-body='{}'
```

**Code note:** Protect `/internal/*` with `X-Internal-Token` before going public (add middleware if not yet wired). Until then, keep Scheduler + API on authenticated invoke or Cloud Armor.

---

## 3. Phase B — WhatsApp (Meta Cloud API)

### B1. What you are buying

- Meta **WhatsApp Business Platform** (Cloud API)  
- A phone number dedicated to LocalMeals (not your personal WA)  
- Message templates for outbound outside the 24h customer-care window (cut-off digest, pay link reminders)

### B2. Setup steps

1. Create/verify **Meta Business Manager**  
2. Add **WhatsApp** product → create WABA  
3. In [developers.facebook.com](https://developers.facebook.com): create an **App** → WhatsApp → start  
4. Add a test number, then request a production number  
5. Copy:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary / permanent access token** → `WHATSAPP_ACCESS_TOKEN`
   - App **secret** → `WHATSAPP_APP_SECRET`
6. Set a random verify string → `WHATSAPP_VERIFY_TOKEN`
7. Configure webhook:
   - Callback URL: `https://YOUR_API/webhooks/whatsapp`
   - Verify token: same as `WHATSAPP_VERIFY_TOKEN`
   - Subscribe: `messages`
8. In LocalMeals env: `MOCK_WHATSAPP=false`

### B3. Templates to submit for approval (MVP-1)

| Template name (example) | When sent | Body idea |
|-------------------------|-----------|-----------|
| `lunch_pay_link` | After order create | Order id + pay URL |
| `cook_manifest` | After cut-off | Plate count + route link |
| `order_refunded` | Admin refund | Amount / reason |

Until approved, you can only free-form reply inside the customer-initiated 24h window (our mock path already maps Menu / Order / Pay / Help).

### B4. Local vs prod

| Env | Setting |
|-----|---------|
| Laptop | `MOCK_WHATSAPP=true` — use `/wa` page |
| Staging/Prod | `MOCK_WHATSAPP=false` + real secrets |

Adapter lives in `packages/adapters/src/whatsapp.ts`.

---

## 4. Phase C — Payments (Razorpay)

### C1. Why Razorpay Route

MVP-1 model: customer pays platform → **EOD** cook settlement (not per-order marketplace commission). Route / Easy Split / linked accounts hold cook payout beneficiary IDs (`payout_beneficiary_ref` on `cook_profiles`).

### C2. Setup steps

1. Razorpay Dashboard → **Test mode**  
2. Generate **Key ID / Key Secret**  
3. Enable **Webhooks** → `https://YOUR_API/webhooks/payments`  
   - One endpoint handles pay / fail / refund / Route transfer / payout / settlement  
   - Events: see `RAZORPAY_WEBHOOK_EVENTS` in `packages/adapters/src/payments.ts` and [MVP1_LAUNCH.md](./MVP1_LAUNCH.md)  
   - Copy webhook secret → `RAZORPAY_WEBHOOK_SECRET`  
4. Create **linked accounts / Route** for each LIVE cook; store account id as `payout_beneficiary_ref`  
5. Prod: switch keys, set `MOCK_PAYMENTS=false`

### C3. Compliance reminder

Do not take real customer money in production until:

- Refund path tested end-to-end  
- Settlement hold / admin refund audited  
- Counsel / payment partner KYC checklist done (product blueprint §17)

---

## 5. GitHub Actions pipeline

Workflows live in `.github/workflows/`:

| File | Purpose |
|------|---------|
| `ci.yml` | On PR/push: install, build packages, test |
| `deploy.yml` | On `main` / manual: CI gate → build/push images → deploy api · worker · web |

### D0. One-time WIF setup (Terraform)

```hcl
# infra/terraform/terraform.tfvars
create_github_wif = true
github_repository = "YOUR_GITHUB_USER/localmeals"   # OWNER/REPO
```

```bash
# WIF needs these APIs (if enable_apis=false, turn them on once):
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com iam.googleapis.com --project=home-food-513806

cd infra/terraform && terraform apply
terraform output -json github_actions_secrets
```

Paste the output into GitHub → **Settings → Secrets and variables → Actions**.

### D1. GitHub secrets / variables

**Secrets**

| Secret | Purpose |
|--------|---------|
| `GCP_PROJECT_ID` | `home-food-513806` |
| `GCP_REGION` | `asia-south1` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | from `terraform output` |
| `GCP_SERVICE_ACCOUNT` | `localmeals-github-deploy@….iam.gserviceaccount.com` |
| `NEXT_PUBLIC_API_URL` | Public API URL (set after first API deploy) |
| `WEB_ORIGIN` | Public web URL (CORS / payment return) — optional until web is up |

**Variables**

| Variable | Purpose |
|----------|---------|
| `ENABLE_GCP_DEPLOY` | `true` to allow deploy workflow |
| `MOCK_PAYMENTS` | default `true` until Razorpay webhook live |
| `MOCK_WHATSAPP` | default `true` until Meta webhook live |
| `MOCK_AUTH` | default `true` |
| `AUTH_ENFORCE` | default `false`; set `true` in staging/prod |

Also create GitHub **Environment** named `production` (workflow references it).

### D2. Branch strategy

- `main` → production deploy (when `ENABLE_GCP_DEPLOY=true`)  
- PRs → CI only  
- Manual: Actions → **Deploy Cloud Run** → Run workflow  

### D3. What the pipeline does

1. CI gate (`npm ci` → build → migrate → test)  
2. Docker build + push `api` / `worker` / `web` tagged with `github.sha`  
3. `gcloud run deploy` with Secret Manager mounts + `localmeals-run` SA  
4. Job summary prints API + web URLs  

Keep mocks on for the first deploys; flip repo vars after webhooks work.

---

## 6. Delivery partners — when and how (MVP-2)

**Do not integrate yet.** MVP-1 is **SELF**: cook delivers; we only generate Google Maps multi-stop links.

When you are ready (MVP-2):

| Partner | You integrate | They use |
|---------|---------------|----------|
| Shadowfax / Porter / local fleet | Create job API + status webhooks | **Their** rider app |
| LocalMeals | Never build a rider app | — |

Prep work you can do now without a contract:

1. Keep order states: `PACKED → DISPATCHED → DELIVERED / LOGISTICS_EXCEPTION`  
2. Add adapter interface later: `createJob(order)`, `handleWebhook(payload)`  
3. Store `partner_job_id` on order when you add the column  

---

## 7. Recommended launch order (checklist)

Copy this into an issue and tick:

### Week 0 — local certainty
- [ ] `npm run dev:api|worker|web` works with Docker/Homebrew Postgres  
- [ ] Seed pin `600119`, full order → cut-off → deliver → EOD  
- [ ] Admin refund / hold / pause tested  

### Week 1 — GCP staging
- [ ] Project + APIs + Artifact Registry  
- [ ] Cloud SQL + migrate  
- [ ] Cloud Run api/worker/web (mocks still ON)  
- [ ] Custom domain optional  
- [ ] GitHub Actions CI green  

### Week 2 — channels staging
- [ ] Meta WABA test number + webhook verify  
- [ ] Razorpay test keys + webhook  
- [ ] Flip `MOCK_*=false` on staging  
- [ ] Scheduler jobs for cut-off / EOD  

### Week 3 — harden + prod
- [ ] Internal job auth on `/internal/*`  
- [ ] Alerts: Cloud Monitoring on 5xx, Scheduler failures  
- [ ] Prod project mirror  
- [ ] Deploy via Actions on `main`  
- [ ] First real cook LIVE + FSSAI + payout beneficiary  

### Explicitly later
- [ ] IVR (Exotel)  
- [ ] Shadowfax  
- [ ] Pub/Sub replacing in-process outbox poller  

---

## 8. Observability (minimum)

| Signal | Tool |
|--------|------|
| API 5xx rate | Cloud Monitoring alert → email |
| Scheduler job failed | Cloud Scheduler → Monitoring |
| Webhook HMAC rejects | Log metric `webhook.signature_failed` |
| Outbox / WA send failures | Log metrics `outbox.failed` / `whatsapp.send_failed` |
| Stuck UPI confirm | Worker scan → `payment.confirming_stuck` |
| EOD transfer fail | `settlement.batch_failed` (+ success `settlement.batch_completed`) |
| Cut-off | `cutoff.reached` metric (join with Scheduler alerts) |

Details: [OBSERVABILITY.md](./OBSERVABILITY.md). Set Terraform `alert_email` to create policies.

---

## 9. Env matrix (quick reference)

| Variable | Local | Staging/Prod |
|----------|-------|--------------|
| `DATABASE_URL` | local Postgres | Secret Manager / Cloud SQL socket |
| `MOCK_WHATSAPP` | `true` | `false` |
| `MOCK_PAYMENTS` | `true` | `false` |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:4000` | `https://api.…` |
| `WEB_ORIGIN` | `http://localhost:3000` | `https://app.…` |
| `LUNCH_CUTOFF_HOUR` | default for new cooks | `8` (cooks override in desk) |
| `ENABLE_AUTO_CUTOFF` | `false` | prefer Scheduler, keep false on worker |

---

## 10. Common pitfalls

1. **Building web without `NEXT_PUBLIC_API_URL`** — baked in at build time; wrong URL = broken browser calls.  
2. **Cloud SQL from laptop** — use Auth Proxy; don’t open `0.0.0.0` public IP long-term.  
3. **WhatsApp webhook verify fails** — token mismatch or API not publicly reachable.  
4. **Razorpay webhook without raw body HMAC** — implemented (`X-Razorpay-Signature` + raw body). Keep `MOCK_PAYMENTS=true` until secret is set.  
5. **Scheduler hits unauthenticated `/internal/*`** — set `INTERNAL_JOB_TOKEN` and send `X-Internal-Token` (required in production).  
6. **Expecting delivery partner in MVP-1** — out of scope; SELF Maps only.

---

## 11. Related docs

- [DEPLOY.md](./DEPLOY.md) — short Cloud Run checklist  
- [API.md](./API.md) — HTTP surface  
- [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) — architecture  
- Repo root [README.md](../README.md) — local run  

If you want the next engineering ticket after this guide: **“Add `X-Internal-Token` guard on `/internal/*` + Cloud Run Job for migrations.”**
