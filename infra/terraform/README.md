# LocalMeals GCP — Terraform (MVP-1)

Infrastructure as code for project **`home-food-513806`**. Prefer this over ad-hoc `gcloud` so nothing is forgotten and changes are reviewable.

## What it manages

| Resource | Name / notes |
|----------|----------------|
| APIs | Run, SQL, Secret Manager, Artifact Registry, Pub/Sub, Scheduler, VPC Access, Monitoring, … |
| Artifact Registry | `asia-south1` / `localmeals` (Docker) |
| Cloud SQL | `localmeals-pg` Postgres 16 `db-f1-micro` ENTERPRISE |
| DB + user | `localmeals` / `localmeals` |
| VPC connector | `localmeals-conn` (`10.8.0.0/28`) |
| Pub/Sub | **Off by default** (`create_pubsub=false`) — worker uses DB outbox |
| Secrets | `DATABASE_URL`, `INTERNAL_JOB_TOKEN`, `AUTH_SECRET`, `ADMIN_MOBILES`, WhatsApp/Razorpay |
| Runtime SA | `localmeals-run` (Cloud SQL client + secret accessor + Pub/Sub subscriber + uploads objectAdmin) |
| Uploads bucket | `{project}-localmeals-uploads` (private; API sets `GCS_UPLOADS_BUCKET`) |
| Status page bucket | optional (`enable_status_page`) — hosts `infra/status/index.html` |
| Cloud Run | **api** (public) · **worker** (internal) · **web** (public) — gated by `create_cloud_run` |
| Scheduler | `localmeals-lunch-cutoff` · `localmeals-eod` (needs `api_url` / `web_public_api_url` / custom domain / TF API) |
| Monitoring | Email (+ `alert_channels_extra`) · 5xx / p95 latency · uptime · Scheduler · log-based alerts · **LocalMeals ops** dashboard when `alert_email` set |
| Optional | Custom domain mappings · GCS tfstate bucket · GitHub Actions WIF |

Cloud Run stays **off** in Terraform until `create_cloud_run=true` + image URIs. Scheduler and monitoring work with CI-deployed Run when you set `api_url` / `web_url` / `api_service_name`.

**Solo cost defaults:** API/web min 0 + `cpu_idle`, worker min 1 + 5 s poll, no Pub/Sub, GCS lifecycle, Artifact cleanup, `solo_kitchen_slug`. See [docs/COST.md](../../docs/COST.md) and `scripts/cost-sleep-staging.sh`.

## Prerequisites

```bash
brew install terraform         # or tfenv
gcloud auth application-default login
gcloud auth application-default set-quota-project home-food-513806
gcloud config set project home-food-513806
```

## First-time apply (greenfield)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # optional edits
terraform init
terraform plan
terraform apply
```

## Existing resources (this project already has some)

1. Wait until SQL is ready:

```bash
gcloud sql instances describe localmeals-pg --format='value(state)'
# expect RUNNABLE
```

2. Import, then reconcile:

```bash
cd infra/terraform
terraform init
chmod +x import-existing.sh
./import-existing.sh
terraform plan
terraform apply
```

`apply` may rotate the DB password (Terraform-owned `random_password`) and refresh `DATABASE_URL` — save outputs / Secret Manager value.

## Enable Cloud Run + Scheduler

After images are in Artifact Registry (TF-managed Run):

```hcl
create_cloud_run = true
api_image        = "asia-south1-docker.pkg.dev/home-food-513806/localmeals/api:latest"
worker_image     = "asia-south1-docker.pkg.dev/home-food-513806/localmeals/worker:latest"
web_image        = "asia-south1-docker.pkg.dev/home-food-513806/localmeals/web:latest"
web_public_api_url = "https://….run.app"  # bake into web builds ideally
web_origin         = "https://….run.app"
create_scheduler   = true
# alert_email      = "you@example.com"
```

Or keep `create_cloud_run=false` (GitHub Actions owns Run) and still create Scheduler + alerts:

```hcl
create_cloud_run   = false
api_url            = "https://localmeals-api-xxxxx-as.a.run.app"
web_url            = "https://localmeals-web-xxxxx-as.a.run.app"
api_service_name   = "localmeals-api"
create_scheduler   = true
alert_email        = "you@example.com"
# alert_channels_extra = ["projects/…/notificationChannels/…"]
```

```bash
terraform apply
```

Then point Razorpay + Meta webhooks at the API URL (`terraform output api_url` or your `api_url` tfvar).

### Import existing Scheduler jobs

If `localmeals-lunch-cutoff` / `localmeals-eod` (etc.) already exist in GCP, import before apply:

```bash
PROJECT_ID=home-food-513806
REGION=asia-south1

terraform import 'google_cloud_scheduler_job.lunch_cutoff[0]' \
  "projects/${PROJECT_ID}/locations/${REGION}/jobs/localmeals-lunch-cutoff"
terraform import 'google_cloud_scheduler_job.eod_settlement[0]' \
  "projects/${PROJECT_ID}/locations/${REGION}/jobs/localmeals-eod"
terraform import 'google_cloud_scheduler_job.breakfast_cutoff[0]' \
  "projects/${PROJECT_ID}/locations/${REGION}/jobs/localmeals-breakfast-cutoff"
terraform import 'google_cloud_scheduler_job.dinner_cutoff[0]' \
  "projects/${PROJECT_ID}/locations/${REGION}/jobs/localmeals-dinner-cutoff"
terraform import 'google_cloud_scheduler_job.expire_unpaid[0]' \
  "projects/${PROJECT_ID}/locations/${REGION}/jobs/localmeals-expire-unpaid"
```

Also documented in [docs/RUNBOOK.md §3](../../docs/RUNBOOK.md#3-scheduled-jobs).

## Useful outputs

```bash
terraform output artifact_registry
terraform output sql_connection_name
terraform output api_url
terraform output next_steps
```

## Remote state (required)

`versions.tf` declares `backend "gcs" {}`; bucket/prefix are in `backend.hcl`. Local state on one laptop
is a single point of failure and holds the DB password in plain text — migrate once:

```bash
# 1. Create the versioned, private bucket (once). Either:
gcloud storage buckets create gs://home-food-513806-tfstate --location=asia-south1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://home-food-513806-tfstate --versioning
#    …or set create_tf_state_bucket = true and apply with the OLD local backend first.

# 2. Move local state into the bucket (answers "yes" to copy existing state):
terraform init -backend-config=backend.hcl -migrate-state

# 3. Verify, then delete the local copies (they contain secrets):
terraform state list | head
rm terraform.tfstate terraform.tfstate.backup
```

Grant only the ops group / deploy SA `roles/storage.objectAdmin` on that bucket.

## Database resilience

- `db_pitr_enabled` (default **true**) + `db_log_retention_days` (7) → point-in-time restore to any second in the last 7 days.
- `db_backup_retained_count` (14) daily backups at 23:30 IST.
- `db_max_connections` + `check.db_connection_budget` — plan fails if API/worker pools exceed 80% of max connections ([COST.md](../../docs/COST.md)).
- `db_availability_type = "REGIONAL"` for HA failover (≈2× DB cost); `db_tier` ≥ `db-g1-small` recommended for launch (f1-micro is shared-core, no SLA, ~25 connections).
- `log_archive_enabled` — Cloud Run logs → GCS with 180-day lifecycle ([DATA_RETENTION.md](../../docs/DATA_RETENTION.md)).
- `backup_export_bucket` — stub for off-project weekly SQL export.
- Restore drill: `scripts/restore-drill.sh` · [docs/RUNBOOK.md §13](../../docs/RUNBOOK.md).

## Destroy

Do **not** destroy prod casually. `deletion_protection = true` on Cloud SQL. To tear down staging later: remove protection, then `terraform destroy`.
