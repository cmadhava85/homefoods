# Cloud Run deploy checklist (MVP-1)

**Full beginner guide:** [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) (GCP + WhatsApp + Razorpay + GitHub Actions + what to skip).

**Infra as code:** [../infra/terraform/README.md](../infra/terraform/README.md) — use Terraform instead of one-off `gcloud` creates.

## Short checklist

1. Provision Cloud SQL Postgres 16 (+ PostGIS when needed).
2. Put `DATABASE_URL` and channel secrets in Secret Manager (include `INTERNAL_JOB_TOKEN`).
3. Build three images (`apps/api|worker|web` Dockerfiles) → Artifact Registry.
4. Deploy API + Worker + Web on Cloud Run (`--add-cloudsql-instances`; no VPC connector needed).
5. Cloud Scheduler (header `X-Internal-Token`):
   - `POST /internal/cutoffs/LUNCH` (Asia/Kolkata, cook cut-off window)
   - `POST /internal/settlements/eod` at 21:00 IST (after dinner; catch-up for unsettled delivered)
6. Meta WhatsApp + Razorpay webhooks → API HTTPS; set `MOCK_*=false` (see [MVP1_LAUNCH.md](./MVP1_LAUNCH.md)).
7. GitHub Actions: set `ENABLE_GCP_DEPLOY=true` + WIF secrets (see [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) §5). Push to `main` or run **Deploy Cloud Run** manually.
8. Alerts: 5xx, Scheduler failures, cut-off / EOD miss.
9. Confirm API has `GCS_UPLOADS_BUCKET` (Terraform uploads bucket) so menu/concern photos survive multi-instance Run.
10. Smoke: `SMOKE_API_URL=$API_URL node scripts/smoke-staging.mjs`
11. First LIVE cook: FSSAI + Razorpay `payout_beneficiary_ref`.

**MVP-1 delivery:** SELF only (Maps links). Shadowfax / IVR = later.
