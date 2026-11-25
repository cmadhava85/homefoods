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
| Solo overlay | `solo_kitchen_slug=csk-homemade-delights` → single kitchen; platform fee seeded at ₹0 on first boot (then Admin → Features → Pricing) |

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

## Cost-saving features (Nov 2026)

| Area | What changed | Turn on |
|------|--------------|---------|
| Worker | **Scale to zero.** `WORKER_MODE=push`: API publishes a debounced wake to Pub/Sub `localmeals.outbox-wake` after a response that queued outbox rows → push subscription → `POST <worker>/drain`. 1-minute Cloud Scheduler `/drain` fallback. CPU billed only during drains. Was: min 1 instance, always-on CPU (~$40–50/mo). | `terraform apply` (default `worker_push_mode = true`), **then** repo var `WORKER_PUSH_MODE=true`. Rollback: set the var to `false` (min 1 poller). |
| Rate limiting | Global per-IP limit counted **in memory** per instance; route limits (OTP, login, orders, uploads, deletion) stay in Postgres. Removes one DB upsert from every request. | Default. `RATE_LIMIT_GLOBAL_STORE=postgres` restores the old behaviour. |
| Images | API/worker: production deps only, compiled output, OTel SDK only with `--build-arg WITH_OTEL=true`. Web: Next `standalone`. ~317 / 258 / 351 MB (was the whole workspace + dev tools). Also fixes the API image missing `@localmeals/i18n`. | Default. |
| Logs | `run.googleapis.com/requests` entries with status < 400 excluded (the app logs its own `request.completed`). | `log_exclusions_enabled = true` (default). |
| Menu photos | Served from public bucket `…-menu-public` (edge-cached, immutable) instead of streaming through the API. Concern photos stay private. | `terraform apply` (`menu_images_public = true`), copy old photos once (below), then repo var `MENU_IMAGES_PUBLIC=true`. |
| WhatsApp | Templates used **only outside** Meta's 24 h window; inside it the free-form message is sent (free). Saves on marketing-category templates (menu alerts). | Default. |
| Razorpay refunds | `speed: "normal"` always — never Instant Refund (₹7.99+ each). | Default. |
| Refund to credit | Customer can take a cancel refund as instant LocalMeals credit — no gateway refund; credit is spent first at checkout; fully credit-paid orders never touch Razorpay (0 fee). | Admin → Features → `wallet_credit_enabled` (on by default). |
| Convenience fee | Gateway cost passed to the customer, shown before pay: links 2.36 %, pickup UPI QR 1.17 % (`GATEWAY_FEE_BPS`, override `CONVENIENCE_FEE_BPS_LINK/_UPI_QR`). Charged on the gateway part only; refunded with the order. | Admin → Features → `convenience_fee_enabled` — **off by default; switch on after legal review of Terms / Refunds text.** |
| Pickup UPI QR | Single-use, fixed-amount Razorpay QR (0.99 % vs 2 %) for PICKUP orders; pay page shows the QR and polls; `qr_code.credited` webhook marks paid. | `upi_qr_pickup_enabled` (on) + `pickup_enabled`. **Add `qr_code.credited` to the Razorpay dashboard webhook events.** |
| VPC connector | **Removed** (`vpc_connector_enabled = false`). It only routed private-range egress and nothing uses a private IP — Cloud SQL goes through the `/cloudsql` connector. Saves ≥2 always-on connector VMs (~$12/mo ≈ ₹1,000). | `terraform apply` (detaches API/worker, then deletes the connector). The deploy workflow passes `--clear-vpc-connector` unless repo var `VPC_CONNECTOR=true`. |
| Confirm before pay | Week-cart checkout shows food, discount, delivery, platform fee, convenience fee, credit, payment method, cut-off and cancellation note before creating the payment — fewer paid-then-refunded orders. | Default. |

One-time copy of existing menu photos into the public bucket (before setting `MENU_IMAGES_PUBLIC=true`):

```bash
gcloud storage cp "gs://${PROJECT_ID}-localmeals-uploads/menu-*" "gs://${PROJECT_ID}-localmeals-menu-public/" \
  --cache-control="public, max-age=31536000, immutable"
```

### Cloud SQL

- **Committed use discount:** once the tier is settled after launch, buy a 1-year Cloud SQL CUD (Console → Billing → Commitments) — ~25 % off vCPU/memory (3-year ≈ 52 %). Not available for shared-core `db-f1-micro`; applies from `db-g1-small`/custom tiers.
- **Staging:** never keep a second always-on instance — use the sleep scripts below, or point staging at a database on the same instance.
- Keep PITR on (WAL storage is small) — it is the cheapest insurance in the stack.

#### Tier upgrade path (capacity)

`db-f1-micro` is shared-core, no SLA, and ~**25** `max_connections`. With default pools (`api_max_instances`×`db_pool_max_api` + worker + 3 headroom) Terraform’s `check.db_connection_budget` requires usage ≤ **80%** of `db_max_connections` — so f1-micro often fails plan until you lower pools or upgrade. Set `db_max_connections` to the real Cloud SQL value after each tier change.

| Tier | Rough `max_connections` | Compute (ZONAL, asia-south1, list ≈) | When |
|------|-------------------------|--------------------------------------|------|
| `db-f1-micro` (default) | ~25 | ~$8–10/mo (~₹700–850) | Staging / idle demos only |
| `db-g1-small` | ~50 | ~$31/mo (~₹2,600) — **≈ +$21 / ≈ +₹1,800 vs f1-micro** | First LIVE lunch pin; still shared-core, no SLA |
| `db-custom-1-3840` | ~100 | ~$50–55/mo (~₹4,200–4,600) — **≈ +$20–25 / ≈ +₹1,700–2,100 vs g1-small** | Launch when you need a dedicated vCPU + headroom for API max-instances ≥ 5 |

Example after upgrading:

```hcl
db_tier            = "db-g1-small"
db_max_connections = 50
# or
db_tier            = "db-custom-1-3840"
db_max_connections = 100
```

HA (`db_availability_type = "REGIONAL"`) roughly **2×** the instance cost above — buy it when lunch downtime is unacceptable.

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
- `catering_enabled` — MVP-3 party orders (**OFF** by default). No infra cost while off (4 empty tables). When on: 2 payment links per booking — Razorpay ~2% + GST on each, absorbed by the platform (the convenience fee is not applied to party orders) — ~4 WhatsApp messages per booking, and one Cloud Scheduler job for balance reminders.  

Unset `SOLO_KITCHEN_SLUG` / `NEXT_PUBLIC_SOLO_KITCHEN_SLUG` (and TF `solo_kitchen_slug = ""`) when leaving solo → restores multi-cook. The platform fee no longer follows the env — set it in Admin → Features → Pricing.

## Do not cut for “savings”

- Prod worker **min 1** if you run it in poll mode (push mode needs the wake topic + scheduler fallback instead)  
- Cloud SQL backups  
- Webhook HMAC verification  
