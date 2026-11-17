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
| Pub/Sub | topics `localmeals.*` + worker pull subscriptions + DLQ |
| Secrets | `DATABASE_URL`, `INTERNAL_JOB_TOKEN`, `AUTH_SECRET`, `ADMIN_MOBILES`, WhatsApp/Razorpay |
| Runtime SA | `localmeals-run` (Cloud SQL client + secret accessor + Pub/Sub subscriber + uploads objectAdmin) |
| Uploads bucket | `{project}-localmeals-uploads` (private; API sets `GCS_UPLOADS_BUCKET`) |
| Cloud Run | **api** (public) · **worker** (internal) · **web** (public) — gated by `create_cloud_run` |
| Scheduler | `localmeals-lunch-cutoff` (08:00 IST) · `localmeals-eod` (18:00 IST) |
| Monitoring | Email + API 5xx + Scheduler + log-based alerts (webhook sig, outbox, WA send, stuck payment, EOD fail) when `alert_email` set |
| Optional | Custom domain mappings · GCS tfstate bucket · GitHub Actions WIF |

Cloud Run / Scheduler stay **off** until images exist (`create_cloud_run=true` + image URIs).

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

After images are in Artifact Registry:

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

```bash
terraform apply
```

Then point Razorpay + Meta webhooks at the API URL (`terraform output api_url`).

## Useful outputs

```bash
terraform output artifact_registry
terraform output sql_connection_name
terraform output api_url
terraform output next_steps
```

## Remote state (recommended)

```bash
# Option A — Terraform creates the bucket
# create_tf_state_bucket = true
# terraform apply

# Option B — manual
gsutil mb -l asia-south1 gs://home-food-513806-tfstate

# Then uncomment backend "gcs" in versions.tf and:
terraform init -migrate-state
```

## Destroy

Do **not** destroy prod casually. `deletion_protection = true` on Cloud SQL. To tear down staging later: remove protection, then `terraform destroy`.
