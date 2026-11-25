# Pending items (LocalMeals)

Last updated after ads scaffold + deploy CI harden (migrations through `0029` in repo).

## Block launch / staging ops

| Item | Status |
|------|--------|
| Migrate Cloud SQL through latest drizzle journal | **Pipeline migrate job only** (see RUNBOOK §4). API/worker refuse to boot in production when `applied < expected` unless `ALLOW_SCHEMA_BEHIND=true`. |
| Uploads bucket + `GCS_UPLOADS_BUCKET` on API | **Done** — `gs://home-food-513806-localmeals-uploads`; Run SA `objectAdmin`; API env set. Deploy workflow now keeps the env var. TF state import blocked on ADC reauth (`gcloud auth application-default login` then `terraform import` in `infra/terraform`) |
| Sync local `.env` WA + Razorpay from SM | **Done** — `npm run secrets:sync` (script fixed for macOS bash 3.2) |
| Refresh WA secrets on Run | **Done** — api `00020`, worker `00006` rebound to SM `:latest` |
| Staging smoke | **Done** — `7/7` on `https://localmeals-api-1031170612008.asia-south1.run.app` |
| Redeploy api + web + worker images | **In progress** — push ads + desk + docs; watch Deploy Cloud Run; then smoke |
| GitHub Actions CI / ZAP | **Root cause fixed locally** — `*.tsbuildinfo` gitignored; CI cleans buildinfo before build. Re-runs on your push. |
| WhatsApp phone test | **Needs you** — Meta → add your number as test recipient → message business/test number → confirm OTP / menu / pay ping |
| Post-deploy smoke | Order CSK lunch → Razorpay (or mock) → cook desk stop → deliver → Admin Features kill-switch spot-check |
| WA utility templates | Optional until outside-24h outbound needed |
| Self delivery fee / distance flags | Default **OFF** (free delivery). Turn on in Admin → Features only after address GPS/PIN centroids look right |

## In repo, not vendor-ready

| Item | Notes |
|------|--------|
| Shadowfax / partner delivery | Mock + generic HTTP provider + webhook HMAC done; vendor gateway still needed for live. Setup later: [Shadowfax A–E](./LOGISTICS.md#shadowfax-hyperlocal-marketplace--step-by-step) · backup [Porter A–E](./LOGISTICS.md#porter-backup-partner--step-by-step) (optional Borzo) |
| IVR (Exotel/Twilio) | Stub `getIvrProvider()` — wire after vendor |

## Roadmap backlog

See [ROADMAP.md](./ROADMAP.md).

| Item | Horizon |
|------|---------|
| MVP-2 cook desk polish (pause, fulfillment, templates, FSSAI help, lean WA) | **Live** — Cloud SQL `0027`; api/worker/web `polish-202611181526` |
| Temporary solo-kitchen overlay | **In repo** — launch kitchen **CSK Homemade Delights** (`csk-homemade-delights`). Set **both** `SOLO_KITCHEN_SLUG` (API/worker) + `NEXT_PUBLIC_SOLO_KITCHEN_SLUG` (web build). Terraform `solo_kitchen_slug` wires both on Cloud Run. Redirects `/` + `/discover` → kitchen, hides enroll, filters kitchens, blocks apply. Launch pricing: **SELF** delivery, **₹0 delivery**, **₹0 platform fee** seeded on first boot while solo env is set (then Admin → Features → Pricing owns it). Cost lean defaults: [COST.md](./COST.md). Unset solo env to restore multi-cook. |
| Party & bulk catering (MOQ, 48–72h, 50% advance) | MVP-3 — [MVP3.md](./MVP3.md) |
| Radius / PostGIS discovery | MVP-3+ |

## Already built (toggle via Admin → Features)

- Customer ordering (master)
- Late orders
- Child Pays / Family
- Week cart discounts
- Reviews
- WhatsApp outbound
- Kitchen follow alerts
- EOD settlement job
- **Kitchen pickup** (default **OFF**) — landmark after pay, restricted window, ₹0 delivery; cook desk Menu & settings → enable + landmark (`PATCH /cooks/:slug/pickup`)
- **Ads & kitchen boosts** (default **OFF**) — `ads_enabled`; Admin Ads + Discover sponsored + cook boost request; keep off until pin volume is healthy

## Ops ritual

1. Admin → **Features** — flip off if incident  
2. Admin → **Payouts** — Mark paid + UTR after EOD  
3. Admin → **Cooks** — keep UPI filled for LIVE kitchens  
4. Admin → **Analytics** — week/month/year turnover CSV for Route / RBI reviews  

## Built for Route filings

- `GET /admin/analytics/turnover` aggregates paid-order food GMV, platform/delivery fees, refunds, and settlement nets per cook for week / month / year (or custom `from`–`to`).  
