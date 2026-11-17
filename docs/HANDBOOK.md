# LocalMeals handbook

**Audience:** engineers, ops, and product picking up the system  
**Companion:** [RUNBOOK.md](./RUNBOOK.md) (day-2 ops & incidents) · [docs index](./README.md)

---

## 1. What LocalMeals is

LocalMeals (HomeFood) is a **hyper-local home-kitchen lunch marketplace**.

- **One pin first** (e.g. `600119`) — density before breadth  
- **Lunch-first** (breakfast/dinner can be enabled later per cook)  
- **Customers** order on web or WhatsApp  
- **Cooks** run a light web desk + WhatsApp Status  
- **Platform fee** ₹7 **once per checkout** (week cart ≠ ₹7/day); cook gets **100% of food** at launch  
- **Delivery:** SELF (Maps + WA) first; pickup optional (feature-flagged); partner logistics later  

### Why we build it (5 Whys)

1. Neighbours need reliable **home-style lunch** in their pin.  
2. Restaurant aggregators are expensive / impersonal for this wedge.  
3. Home cooks need **fair take-home**, FSSAI LIVE gates, and simple cut-offs — not city-wide dark-store ops.  
4. Trust + tiny fee + EOD settlement keep supply and demand healthy.  
5. **Root why:** unlock verified home kitchens as a daily lunch option with a fair money loop.

Product locks: [PRODUCT_DECISIONS.md](./PRODUCT_DECISIONS.md).

---

## 2. Who uses what

| Role | Primary surfaces | Job |
|------|------------------|-----|
| **Customer** | Web storefront, WhatsApp | Browse LIVE kitchens, order (instant / late / week cart), pay UPI, track status, review after delivery |
| **Family payer (Child Pays)** | Web `/family`, WA `Family` / `PAY` | Accept invite; pay for senior’s order |
| **Cook** | `/cook/:slug`, WA Status | Menu (desk **or** WA `Add …`), cut-off, week discount, pickup, cook → pack → dispatch/deliver, reviews reply, payout UPI |
| **Admin / owner** | `/admin` | Approve cooks, features flags, settlements / Mark paid, tickets, refunds/holds, analytics turnover |
| **System** | Worker + Scheduler | Outbox WA/pay jobs, lunch cut-off, EOD settlements, retention |

Demo (local seed): customer `+919840111111` · cook desk `/cook/sri-sai` · admin `/admin` · WA sim `/wa`.

---

## 3. Core product loops

### Happy path (delivery)

1. Customer picks kitchen + plate → pay (Razorpay Payment Link or mock).  
2. Order → `PAID` → cook **cooking** → **packed** → **dispatched** → **delivered**.  
3. EOD: settlement batch for cook food; Admin **Mark paid** if Route blocked.  
4. If Admin refunds a plate **after** it was already in a cook settlement, food net is queued as **cook clawback** and deducted from that cook’s **next EOD** with delivered volume (partial OK; remainder stays pending).  
5. Unpaid / failed-pay / late-pending orders whose **service date is past** are auto-**CANCELLED** (quiet) so My orders Open stays clean.  

### Cancel

- **Before cut-off:** customer Cancel on My orders (instant). Unpaid / late-pending can cancel anytime.  
- **After cut-off (paid):** **Request cancel** → `CANCEL_REQUESTED` → cook **Accept** (full refund) or **Decline** (back to `PAID`). WA: `Cancel requests` (or Status); desk Cancel requests panel.  
- After cooking started: use **Raise a concern** / Admin.  

### Late order

Past cut-off → cook must **approve** → then pay. Protects cook waste.

### Cook menu (WA)

From the cook WhatsApp number (desk still works):

1. `Add Sambar rice 80` or `Add Chicken biryani 120 nonveg` → today’s lunch plate.  
2. Bot asks for a **photo** — send an image, or `Skip`.  
3. `My menu` lists today’s plates. Same rows appear on customer web kitchen + customer `Menu`.

### Week cart

Multi-day lunch in one checkout; optional cook **% food discount** when day count ≥ min days (delivery + ₹7 never discounted).  
On pay: cook (and customer) get **one WhatsApp per day-line**, each showing **service date**, **day N of M**, and week `checkoutId`. Kitchen ops / Status / EOD stay **per `serviceDate`**.

### Pickup (MVP-2, flag `pickup_enabled`)

₹0 delivery; landmark after pay; cook marks packed → picked up (`DELIVERED` without dispatch).

### Child Pays

Senior invites family → payer accepts → cart “Who pays?” → pay link to payer.

### Reviews (MVP-2)

Only after `DELIVERED` paid order; cook may reply; aggregate ★ soft-launches after N reviews.

Detail: [MVP2.md](./MVP2.md) · API: [API.md](./API.md).

---

## 4. System architecture (handbook view)

```
Customer/Cook/Admin Web (Next.js) ──► API (Fastify / Cloud Run)
WhatsApp (Meta) webhook ───────────► API
Razorpay webhooks ─────────────────► API
Cloud Scheduler ──X-Internal-Token─► API /internal/*
API ◄──► Postgres (Cloud SQL)
API ──outbox──► Worker ──► WhatsApp / payments side effects
Uploads ──► local disk or GCS (GCS_UPLOADS_BUCKET)
```

- **Modular monolith** — route plugins + `services/*` + `@localmeals/domain`  
- **Channels are adapters** — domain owns money, cut-offs, order state  
- **Outbox + worker** — async WA/pay (not required Pub/Sub for MVP)  

Deep dive: [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) · stack guide: [TECH_STACK.md](./TECH_STACK.md) · API layout: [ARCHITECTURE.md](./ARCHITECTURE.md).

### Monorepo map

| Path | Responsibility |
|------|----------------|
| `apps/web` | Next.js UI (customer, cook desk, admin, `/wa` simulator) |
| `apps/api` | HTTP, webhooks, auth, uploads |
| `apps/worker` | Outbox poller; optional cut-off/EOD helpers |
| `packages/domain` | State machine, cut-offs, cook LIVE gates, money, reviews, week discount |
| `packages/db` | Drizzle schema + migrations |
| `packages/adapters` | Payments, WhatsApp, maps, logistics/IVR stubs |
| `packages/i18n` | en/ta strings |
| `infra/terraform` | GCP as code |

---

## 5. Money & trust (business rules)

| Rule | Value |
|------|--------|
| Customer platform fee | ₹7 once per checkout (`PLATFORM_FEE_PAISE=700`); week cart is not ₹7/day |
| Cook food take (launch) | 100% |
| Delivery fee | Platform keeps (with fee); food → cook at EOD |
| LIVE kitchen | FSSAI + active + payout UPI/bank note (Route optional while RBI-blocked) |
| Reviews | Platform-standard for LIVE; no cook opt-out |
| PCI | No card PAN on LocalMeals — Razorpay Payment Links only ([SECURITY.md](./SECURITY.md)) |

Admin **Analytics** → week/month/year turnover for Route / RBI: `GET /admin/analytics/turnover`.

---

## 6. Developer setup

### Prerequisites

- Node 20+ · npm workspaces  
- Postgres 16 (Docker Compose PostGIS preferred, or local with `pgcrypto`)  
- Optional: `gcloud` for Secret Manager sync / Cloud Run  

### First run

```bash
cp .env.example .env
docker compose up -d          # optional
npm install
npm run build -w @localmeals/domain
npm run build -w @localmeals/adapters
npm run build -w @localmeals/db
npm run db:migrate
npm run db:seed

npm run dev:api               # :4000
npm run dev:worker
npm run dev:web               # :3000
```

Open http://localhost:3000 · API health: http://localhost:4000/health  

Local defaults: `MOCK_PAYMENTS=true`, `MOCK_WHATSAPP=true`, `MOCK_AUTH=true`.

### Useful scripts

| Command | Purpose |
|---------|---------|
| `npm test` | Domain + adapters + API suites |
| `npm run test:unit -w @localmeals/api` | Fast API unit tests |
| `npm run test:mutation` | Domain → API → web Stryker ([MUTATION_TESTING.md](./MUTATION_TESTING.md)) |
| `npm run secrets:sync` | Pull secrets from GCP Secret Manager into `.env` |
| `SMOKE_API_URL=… node scripts/smoke-staging.mjs` | Staging smoke |
| `node scripts/smoke-whatsapp.mjs` | WA Graph + HMAC smoke |

### Env cheat sheet

| Variable | Dev | Prod |
|----------|-----|------|
| `DATABASE_URL` | local Postgres | Cloud SQL |
| `AUTH_SECRET` | any long string | strong; never `localmeals-dev-auth-secret` |
| `MOCK_PAYMENTS` / `MOCK_WHATSAPP` / `MOCK_AUTH` | `true` | `false` |
| `INTERNAL_JOB_TOKEN` | local token | Secret Manager; Scheduler header |
| `WEB_ORIGIN` | `http://localhost:3000` | public web URL |
| `GCS_UPLOADS_BUCKET` | unset (disk) | set (multi-instance Run) |
| `ADMIN_MOBILES` | seeded admin | owner mobiles |

Production boot refuses weak mocks/secrets (`assertProductionConfig`). See [INFRASTRUCTURE.md](./INFRASTRUCTURE.md).

### How to extend (patterns)

1. **Domain rule** → `packages/domain` + unit test (mutation-friendly).  
2. **HTTP** → `apps/api/src/plugins/*` + `services/*`; use `sendCaughtError`.  
3. **WhatsApp intent** → register in `wa/dispatch.ts` + handler under `wa/handlers/`.  
4. **Feature flag** → `FEATURE_FLAG_DEFS` + Admin Features UI.  
5. **Schema** → Drizzle migration under `packages/db/drizzle/`.  

---

## 7. Environments & URLs

| Env | Notes |
|-----|--------|
| **Local** | mocks on; `/wa` simulator |
| **Staging / Cloud Run** | See [MVP1_LAUNCH.md](./MVP1_LAUNCH.md) for live URLs & webhook paste targets |
| **Prod** | Same topology; stricter secrets + alerts |

Deploy checklist: [DEPLOY.md](./DEPLOY.md) · Terraform: [infra/terraform/README.md](../infra/terraform/README.md).

---

## 8. Feature flags (Admin → Features)

| Key | Meaning (default) |
|-----|-------------------|
| `ordering_enabled` | Master switch for new orders (on) |
| `late_orders_enabled` | Late requests (on) |
| `child_pays_enabled` | Family pay (on) |
| `week_discount_enabled` | Week % (on) |
| `reviews_enabled` | Reviews (on) |
| `whatsapp_outbound_enabled` | Worker WA send (on) |
| `kitchen_follow_enabled` | Follow alerts (on) |
| `eod_settlement_enabled` | EOD job (on) |
| `pickup_enabled` | Kitchen pickup (**off** until ready) |
| `partner_delivery_enabled` | Partner rider logistics (**off**; needs cook `deliveryType=PARTNER`) |

Incident response: flip flags off in Admin before code rollback when possible ([RUNBOOK.md](./RUNBOOK.md)).

---

## 9. Documentation map

| Need | Doc |
|------|-----|
| This handbook | [HANDBOOK.md](./HANDBOOK.md) |
| Ops / incidents | [RUNBOOK.md](./RUNBOOK.md) |
| Product decisions | [PRODUCT_DECISIONS.md](./PRODUCT_DECISIONS.md) |
| Technical design | [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) |
| API routes | [API.md](./API.md) |
| MVP-2 features | [MVP2.md](./MVP2.md) |
| Infra & GCP | [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) |
| Launch remaining | [MVP1_LAUNCH.md](./MVP1_LAUNCH.md) |
| Open backlog | [PENDING.md](./PENDING.md) |
| Security / PCI | [SECURITY.md](./SECURITY.md) |

---

## 10. Glossary

| Term | Meaning |
|------|---------|
| **Pin** | Delivery PIN / catchment (MVP: one pin) |
| **LIVE** | Cook approved + FSSAI + payout + active — can take paid orders |
| **Cut-off** | Last time customers may order for that meal without late flow |
| **EOD** | End-of-day settlement batch for cook food |
| **Route** | Razorpay Route linked account / transfer (may be RBI-blocked → manual Mark paid) |
| **Outbox** | DB rows for async work the worker drains |
| **Child Pays** | Family payer settles UPI for another customer |
