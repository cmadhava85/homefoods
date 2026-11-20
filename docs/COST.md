# Solo-launch cost controls

Defaults tuned for **one-kitchen / one-pin** launch on GCP. Product fee rules stay in [PRODUCT_DECISIONS.md](./PRODUCT_DECISIONS.md); this page is infra + third-party spend.

## What Terraform already does (solo lean)

| Control | Default |
|---------|---------|
| Cloud SQL | `db-f1-micro`, ZONAL, disk autoresize **cap 20 GB** |
| API / web | **min 0**, max 3, `cpu_idle=true` (CPU billed only on request) |
| Worker | **min 1** (outbox), max 2, poll every **5 s**, `DB_POOL_MAX=2` |
| Pub/Sub | **Off** (`create_pubsub=false`) — unused while worker polls DB outbox |
| OTel | **Off** |
| Logs | `LOG_LEVEL=info` |
| GCS uploads | Nearline after **30 d**, delete after **180 d** |
| Artifact Registry | Keep **5** versions; delete older than **30 d** |
| Solo overlay | `solo_kitchen_slug=csk-homemade-delights` → ₹0 platform fee + single kitchen |

Example / tfvars:

```hcl
solo_kitchen_slug    = "csk-homemade-delights"
create_pubsub        = false
otel_enabled         = false
worker_min_instances = 1   # staging sleep: 0
api_min_instances    = 0
web_min_instances    = 0
```

Apply after editing `infra/terraform/terraform.tfvars`:

```bash
cd infra/terraform && terraform plan && terraform apply
```

If `plan` wants to **destroy** existing Pub/Sub and you are not ready, set `create_pubsub = true` once, then delete later.

## Staging sleep (biggest idle save)

When you are not demoing:

```bash
chmod +x scripts/cost-sleep-staging.sh scripts/cost-wake-staging.sh
./scripts/cost-sleep-staging.sh   # worker min 0 + SQL NEVER
# … days later …
./scripts/cost-wake-staging.sh    # SQL ALWAYS + worker min 1
```

API/web already scale to zero; sleeping **SQL + worker** is the main staging win.

## Third-party (keep lean for solo)

| Vendor | Solo rule |
|--------|-----------|
| Meta WhatsApp | Lean status/pay only; `whatsapp_outbound_enabled` kill switch; mocks on non-prod |
| Razorpay | Payment Links only; no Route until needed; mocks on staging |
| Maps Platform | URL-only (no Distance Matrix / Places SDK) |
| Shadowfax / IVR | **Do not buy** until lunch pin is stable |

## App flags that stop burn

Admin → Features:

- `whatsapp_outbound_enabled` — stop Meta send loops  
- `ordering_enabled` — stop new orders during incidents  
- `eod_settlement_enabled` — skip EOD when payouts broken  

Unset `SOLO_KITCHEN_SLUG` / `NEXT_PUBLIC_SOLO_KITCHEN_SLUG` (and TF `solo_kitchen_slug = ""`) when leaving solo → restores multi-cook + ₹7 fee.

## Do not cut for “savings”

- Prod worker **min 1** while outbox is the notify path  
- Cloud SQL backups  
- Webhook HMAC verification  
