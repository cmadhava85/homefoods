# LocalMeals technology stack (expanded)

Companion to [HANDBOOK.md](./HANDBOOK.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).  
This document explains **every major technology in the repo**, what it is, why it is here, which features we use, and where to look in code.

**Legend**

- **Live** — used in current MVP path  
- **Optional** — wired but off by default  
- **Stub / later** — design or adapter only  

---

## 1. Big picture

```
Browser (Next.js) ──/lm-api──► Fastify API ──► Postgres (Drizzle)
Meta WhatsApp ─────────────────► Fastify webhook
Razorpay ──────────────────────► Fastify webhook
Cloud Scheduler ──X-Internal──► Fastify /internal/*
API writes outbox row (same TX as order)
Worker polls outbox ──► WhatsApp / payment side effects
Uploads ──► disk or GCS
```

### Architectural choices

| Choice | Meaning |
|--------|---------|
| Modular monolith | One deployable API; plugins by role (customer/cook/admin), not microservices |
| Channels as adapters | Web and WhatsApp call the same services; vendors sit in `@localmeals/adapters` |
| Domain package | Money, cut-offs, order transitions live outside HTTP |
| Outbox + worker | Reliable async notify without requiring Pub/Sub for MVP |

### Where to start reading

1. Product rules → `packages/domain`  
2. HTTP composition → `apps/api/src/app.ts`  
3. One happy path → `apps/api/src/services/orders.ts`  
4. UI path → `apps/web/src/app/kitchen/[slug]/`  

---

## 2. Language & monorepo

### 2.1 TypeScript (**Live**)

**What it is:** Typed superset of JavaScript; compiles to JS for Node and the browser.

**Why here:** One language for web, API, worker, and shared packages. Order states, fee paise, and feature-flag keys stay consistent across layers.

**Important features we use**

| Feature | How we use it |
|---------|----------------|
| Strict-ish project `tsc` | `npm run typecheck` / per-package `tsc` |
| ES modules | `"type": "module"` in API, worker, packages |
| Path imports | Workspace packages via `@localmeals/*` |
| Discriminated unions | Order statuses, WA intents, ticket categories |

**Guidance:** Prefer types that mirror DB enums (`order_state` in Drizzle). Don’t invent parallel string unions in the web app for statuses already defined in domain/DB.

### 2.2 npm workspaces (**Live**)

**What it is:** npm feature to manage multiple packages in one git repo.

**Layout**

| Path | Package | Role |
|------|---------|------|
| `apps/web` | `@localmeals/web` | Next.js UI |
| `apps/api` | `@localmeals/api` | Fastify HTTP |
| `apps/worker` | `@localmeals/worker` | Outbox consumer |
| `packages/domain` | `@localmeals/domain` | Pure rules |
| `packages/db` | `@localmeals/db` | Drizzle schema + migrate/seed |
| `packages/adapters` | `@localmeals/adapters` | Razorpay, WA, maps, stubs |
| `packages/i18n` | `@localmeals/i18n` | en/ta catalogs |

**Commands worth knowing**

```bash
npm run dev:web | dev:api | dev:worker
npm run build          # domain → adapters → i18n → db → apps
npm run db:migrate
npm run db:seed
npm test
```

**Guidance:** Change domain/adapters → rebuild that package (or full `npm run build`) before API/web typecheck, because apps consume `dist/` types.

### 2.3 Node.js + tsx (**Live**)

**What it is:** Node runs the API/worker; **tsx** loads TypeScript in dev/tests without a separate transpile step.

**Used for:** `node --import tsx src/index.ts`, migrations, seeds, `node --test` suites.

**Guidance:** Production images run compiled `dist/` (`npm run build` then `node dist/index.js`). Don’t rely on tsx in Cloud Run.

---

## 3. Frontend

### 3.1 Next.js 15 — App Router (**Live**)

**What it is:** React meta-framework: routing, bundling, server/client split, rewrites.

**Why here:** One app for customer, cook desk, admin, and the WhatsApp simulator.

**Important features we use**

| Feature | LocalMeals usage |
|---------|------------------|
| App Router (`app/`) | Routes: `/discover`, `/kitchen/[slug]`, `/cook/[slug]`, ops UI (path from `NEXT_PUBLIC_ADMIN_PATH`), `/orders`, `/family`, `/wa`, `/pay/...` |
| Client components | Interactive desks, carts, auth (`"use client"`) |
| `next.config` rewrites | Browser calls `/lm-api/*` → API origin so cookies/session stay same-site friendly ([`apps/web/next.config.ts`](../apps/web/next.config.ts), [`lib/api.ts`](../apps/web/src/lib/api.ts)) |
| Middleware | Gate sensitive paths (e.g. `/family`) — [`middleware.ts`](../apps/web/src/middleware.ts) |

**What we don’t lean on (yet):** Next Route Handlers as the main API (business API is Fastify), heavy RSC data fetching for kitchens (mostly client `fetch` + `authFetch`).

**Guidance:** New customer UI → `apps/web/src/app/...`. Call API via `API_BASE` / `authFetch`, never hardcode secrets in the browser.

### 3.2 React 19 (**Live**)

**What it is:** UI component library.

**Important patterns in this repo**

| Pattern | Examples |
|---------|----------|
| Context providers | `AuthProvider`, `LocaleProvider` |
| Controlled forms | Order cart, cook menu, admin tickets |
| Feature-aware UI | `useFeatureFlags()` hides Family/Follow/reviews when Admin disables flags |
| Shared widgets | `CancelOrderButton`, `ReviewForm`, address picker |

**Guidance:** Keep business rules out of components — call the API; display `mode: cancel_requested` etc. from responses.

### 3.3 `@localmeals/i18n` (**Live**)

**What it is:** First-party message catalogs (English + Tamil), not a heavy i18n framework.

**Important features**

| Feature | Usage |
|---------|--------|
| `messages.ts` + `modules.ts` | Base + modular keys (status labels, cook desk) |
| `t(locale, key, params)` | Interpolation `{id}`, `{n}` |
| `MsgKey` type | Compile-time key checking in web |
| `localizedDishName` | Prefer `itemNameTa` when locale is `ta` |
| `localizeError` | Map known English API errors → translated keys |

**Guidance:** Add keys to **both** `en` and `ta`. Rebuild `@localmeals/i18n` after catalog changes.

---

## 4. Backend API (Fastify)

### 4.1 Fastify 5 (**Live**)

**What it is:** High-performance Node HTTP framework with a plugin system and schema-friendly request lifecycle.

**Why not Express/Nest:** Thin plugins, good async error story, strong fit for webhook + JSON APIs without Nest DI overhead. See also [ARCHITECTURE.md](./ARCHITECTURE.md).

**Composition root:** [`apps/api/src/app.ts`](../apps/api/src/app.ts) `buildApp()`.

**Important plugins / features we use**

| Piece | Role in LocalMeals |
|-------|--------------------|
| Content-type / raw body | HMAC verify for Razorpay + WhatsApp signatures |
| `@fastify/cors` | Allow web origin(s) |
| `@fastify/rate-limit` | Throttle OTP/concern/abuse; Postgres store; fail-closed in production |
| `@fastify/multipart` | Menu & concern photo uploads |
| Static or GCS proxy | `GET /uploads/:file` |
| `preHandler` session | Parse Bearer → `currentUser` |
| Route plugins | Bounded contexts (table below) |

**Route plugins**

| Plugin | Surface |
|--------|---------|
| `metaRoutes` | `/health`, `/meta/today`, `/meta/features` |
| `authRoutes` | OTP request/verify, me, logout |
| `customerRoutes` | Kitchens, orders, family, checkouts, concerns, reviews, `/ads` |
| `cookRoutes` | Desk menu, meal-settings, pipeline, late/cancel, boosts |
| `paymentRoutes` | Mock confirm, payment webhooks |
| `adminRoutes` | Tickets, cooks, payouts, flags, ads, order support, analytics |
| `internalRoutes` | Cut-offs, EOD, ops (token-guarded) |
| `whatsappWebhook` | Meta verify + inbound |
| `logisticsWebhook` | Partner shipment status webhooks |
| `uploadsRoutes` | GCS proxy for `/uploads/:name` (else disk static) |

**Guidance:** New HTTP endpoint → correct plugin → call a **service** function → domain asserts. Don’t put cut-off math in the route handler.

### 4.2 Zod (**Live**)

**What it is:** Runtime parser/validator for JS values.

**Why here:** HTTP bodies are untrusted. Zod fails fast with clear 400s before DB writes.

**Examples of validated input:** create order, meal-settings patch, ticket patch, late-request, week discount percent 0–15.

**Guidance:** Zod = shape & bounds. Domain = “is this cook LIVE?”, “can we transition PAID → CANCEL_REQUESTED?”.

### 4.3 dotenv (**Live** locally)

Loads `.env` for `DATABASE_URL`, `MOCK_*`, webhook secrets. In GCP, prefer Secret Manager env injection (see INFRASTRUCTURE).

### 4.4 Observability package (**Live** logs · **Optional** traces)

[`@localmeals/observability`](../packages/observability) — Pino JSON for Cloud Logging, AsyncLocalStorage request correlation, outbox `_corr`, stable `LogEvent` markers, shared `startTelemetry`. Full ops guide: [OBSERVABILITY.md](./OBSERVABILITY.md).

**OTel:** set `OTEL_ENABLED=true` (+ `OTEL_EXPORTER_OTLP_ENDPOINT`) on API and worker. Terraform: `otel_enabled` / `otel_exporter_otlp_endpoint`.

---

## 5. Domain & data

### 5.1 `@localmeals/domain` (**Live**)

**What it is:** Dependency-light package of pure functions and types.

**Important modules (conceptual)**

| Area | Responsibility |
|------|----------------|
| Order state machine | Legal transitions (`PAID` ↔ `CANCEL_REQUESTED`, kitchen ladder, refunds) |
| Cut-offs | Per-meal cutoff times, “before cut-off?”, labels |
| Cook gates | LIVE + FSSAI + payout details before paid orders |
| Money / fees | ₹7 once per checkout (`platformFeePaiseForCheckoutLine`), week discount normalize/cap |
| Feature flags | Flag keys + defaults (`ordering_enabled`, `pickup_enabled`, …) |
| Reviews / week discount / paid notify copy | Soft rules + `orderPaidNotify` WA bodies (day N of M) |

**Guidance:** If a rule must hold for **both** web and WhatsApp, it belongs here (or in a service that both call), not only in a React component.

### 5.2 PostgreSQL / Cloud SQL (**Live**)

**What it is:** Relational database. Prod: **Cloud SQL Postgres 16**. Local: Docker/Homebrew Postgres.

**Why:** Strong consistency for payments, settlements, multi-day checkouts, tickets, outbox.

**Important concepts in our schema**

| Concept | Why it matters |
|---------|----------------|
| `orders` + `order_state` enum | Single lifecycle including `CANCEL_REQUESTED` |
| `cook_profiles` + meal settings | Per-kitchen cut-off, pickup, payout UPI |
| `daily_menus` | Dated + weekly template plates |
| `support_tickets` | Customer concern / Help inbox |
| `outbox` | Async side effects |
| `platform_feature_flags` | Admin kill switches |
| Settlements / payments tables | EOD and refunds |

**PostGIS:** Mentioned in design for future geo; MVP uses pin + lat/lng fields, not heavy spatial queries yet (**later**).

### 5.3 Drizzle ORM + drizzle-kit (**Live**)

**What it is:** TypeScript-first ORM and migration generator.

**Important features we use**

| Feature | Usage |
|---------|--------|
| `pgEnum` / `pgTable` | [`packages/db/src/schema.ts`](../packages/db/src/schema.ts) |
| SQL migrations | `packages/db/drizzle/*.sql` (apply with `npm run db:migrate`) |
| Query API | `db.query.orders.findFirst`, `db.insert`, transactions |
| `postgres` driver | Connection from `DATABASE_URL` |

**Workflow**

1. Edit `schema.ts`  
2. `npm run generate -w @localmeals/db` (drizzle-kit) when adding migrations  
3. `npm run db:migrate` on each environment  
4. Rebuild `@localmeals/db` so API sees new enum types  

**Guidance:** Never “hand patch prod” without a migration. Enum values like `CANCEL_REQUESTED` need `ALTER TYPE ... ADD VALUE`.

### 5.4 Transactional outbox (**Live**)

**What it is:** Pattern: in the **same DB transaction** as a business write, insert an outbox event; a worker publishes/sends later.

**Why:** If WhatsApp is down, the order is still correctly PAID/CANCEL_REQUESTED; messages retry via worker.

**Examples of events:** `CancelRequested`, `CancelDeclined`, `OrderStatusChanged`, late-order notifies, menu posted.

**Vs design doc Pub/Sub:** Pub/Sub remains a scale-up option; MVP does not require it.

---

## 6. Worker (**Live**)

**Package:** `apps/worker`

**What it does**

- Poll / claim outbox rows  
- Send WhatsApp via adapters (pay link, status, cancel ask, menu-related customer pings)  
- Optionally assist cut-off/EOD by calling API internal routes  

**Ops note:** Staging/prod need **≥1 worker instance**. API alone will not drain WhatsApp.

**Guidance:** New customer-visible async message → emit outbox from the service transaction → handle in `apps/worker/src/index.ts`.

---

## 7. Adapters (vendors)

### 7.1 Razorpay (**Live** with mocks)

**What it is:** Indian payment gateway (UPI, cards, etc.).

**Important features we use**

| Feature | Usage |
|---------|--------|
| Payment Links | Customer pays without full PCI card UI on our servers |
| Webhooks | `payment_link.paid` / captured / refunds — HMAC verified |
| Mock mode | `MOCK_PAYMENTS=true` + `/payments/mock-confirm` for local/demo |
| Route / Easy Split | Desired for automatic cook split; **Admin Mark paid** while Route/RBI constrained |

**Security guidance:** Never trust client “I paid”; only webhook or controlled mock. See [SECURITY.md](./SECURITY.md).

### 7.2 Meta WhatsApp Cloud API (**Live** with mocks)

**What it is:** Business messaging API (inbound webhook + Graph outbound).

**Important features we use**

| Feature | Usage |
|---------|--------|
| Webhook verify | `GET` hub challenge |
| Signature check | `X-Hub-Signature-256` when not mock |
| Text + button replies | Customer Menu/Order/Pay; cook Status/Accept |
| Image inbound | Cook menu photo attach (media download or mock base64) |
| Intent parser | [`packages/adapters/src/whatsapp.ts`](../packages/adapters/src/whatsapp.ts) |
| Mock + `/wa` UI | Local chat simulator |

**Cook vs customer:** Same WABA number; behavior depends on whether `from` is a cook mobile.

**Guidance:** New WA command → parser intent → `wa/dispatch.ts` registry → handler. Keep grammar documented in [API.md](./API.md).

### 7.3 Maps helpers (**Live**)

Build Google Maps URLs for delivery stops / routes (cook desk). Not a full Maps Platform SDK integration.

### 7.4 Logistics & IVR (**Stub / later**)

`logistics.ts`, `ivr.ts` — throw/stub only. Product decision: no Shadowfax/IVR in MVP-1.

---

## 8. Auth, flags, uploads

### 8.1 OTP auth (**Live**)

| Piece | Behavior |
|-------|----------|
| `POST /auth/otp/request` | Send/store OTP (mock logs code) |
| `POST /auth/otp/verify` | Returns session token + user |
| Bearer `Authorization` | Subsequent API calls |
| Roles | `CUSTOMER`, `COOK`, `ADMIN` |
| `MOCK_AUTH` | Dev OTP `123456` |

**Guidance:** Cook desk routes assert kitchen staff (slug matches session cook). Customer cancel/concern assert ownership.

### 8.2 Feature flags (**Live**)

**Storage:** `platform_feature_flags`  
**Admin:** Features UI  
**Read:** `GET /meta/features`  
**Web:** `apps/web/src/lib/features.ts` → hide Family/Follow/reviews CTAs when off  
**API:** Services `assertFeatureEnabled` for hard enforcement  

Keys include: ordering, late orders, Child Pays, week discount, reviews, WA outbound, kitchen follow, EOD, pickup.

### 8.3 Uploads (**Live**)

| Feature | Detail |
|---------|--------|
| Magic-byte sniff | JPEG/PNG/WebP/GIF only ([`uploads.ts`](../apps/api/src/uploads.ts)) |
| Size cap | 5MB |
| Prefixes | `menu-…`, `concern-…` |
| GCS | When `GCS_UPLOADS_BUCKET` set — required for multi-instance Cloud Run |
| WA menu photo | `saveMenuImageBuffer` after Meta/mock image inbound |

---

## 9. Cloud & DevOps

### 9.1 Google Cloud Run (**Live** for staging/prod)

Runs **web**, **api**, **worker** as containers. Scales with traffic; staging can scale to zero.

**Guidance:** Attach secrets, set CPU/memory, ensure worker min instances ≥ 1 in production.

### 9.2 Cloud SQL (**Live**)

Managed Postgres. Cloud Run connects via private IP / Auth Proxy / Unix socket (see INFRASTRUCTURE).

### 9.3 GCS (**Live** when configured)

Menu/concern objects. Terraform: `infra/terraform/uploads_bucket.tf`.

### 9.4 Secret Manager (**Live**)

Razorpay keys, WA tokens, `DATABASE_URL`, `INTERNAL_JOB_TOKEN`, etc. Synced into Run env.

### 9.5 Cloud Scheduler (**Live**)

Cron → `POST /internal/cutoffs/LUNCH`, `POST /internal/settlements/eod` with `X-Internal-Token`.

### 9.6 Artifact Registry + GitHub Actions (**Live**)

CI builds images, pushes registry, deploys Cloud Run. WIF avoids long-lived GCP keys in GitHub.

### 9.7 Terraform (**Live**)

`infra/terraform/` — APIs, VPC, SQL, Run, secrets, scheduler, uploads, monitoring, GitHub WIF.

### 9.8 Pub/Sub / Cloud Tasks (**Later**)

In [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) for scale. Current MVP: outbox + worker + Scheduler.

---

## 10. Quality & security tooling

| Technology | Role | How to run |
|------------|------|------------|
| Node.js test runner | API/domain/adapters tests | `npm run test -w @localmeals/api` etc. |
| Vitest | Web unit tests | `npm run test -w @localmeals/web` |
| Playwright | Browser e2e | `npm run test:e2e` |
| Stryker | Mutation testing | `npm run test:mutation` — [MUTATION_TESTING.md](./MUTATION_TESTING.md) |
| OWASP ZAP | DAST | `npm run security:zap` — [DAST.md](./DAST.md) |
| npm audit | Dependency CVEs | `npm run security:audit` |
| Payment probe script | Defensive payment checks | `scripts/payment_security_probe.py` |

**Guidance:** Prefer flow tests that hit Fastify `inject()` for order/pay/WA; keep domain tests pure and fast.

---

## 11. Product features → technologies

| Product feature | Primary tech path |
|-----------------|-------------------|
| Discover / kitchen menu | Next.js + Fastify kitchens APIs + `daily_menus` |
| Instant / week order + pay | Fastify orders + Razorpay link + mock confirm |
| Cook desk pipeline | Next.js desk + Fastify cook routes + domain transitions |
| Cook WA Status / Accept | Meta WA + `wa/handlers/cookOps` + same services |
| Cook WA menu post | WA `Add …` + optional image → `addCookMenuItem` / patch image |
| Cut-off freeze | Domain cutoff + Scheduler + `/internal/cutoffs/:meal` |
| Post–cut-off cancel request | Domain `CANCEL_REQUESTED` + outbox + desk/WA Accept |
| Concerns / tickets | Multipart photo + `support_tickets` + Admin |
| Child Pays | Family links + payer on checkout + flags |
| Pickup | Flag + cook landmark + fulfillment mode |
| Reviews | Post-delivery review + soft-launch count + cook reply |
| EOD / Mark paid | Settlement job + Admin payouts UI |
| i18n | `@localmeals/i18n` en/ta |

---

## 12. Learning path (expanded)

| Week focus | Read / try |
|------------|------------|
| 1. Domain | `packages/domain/src/orderState.ts`, cutoff helpers; run domain tests |
| 2. Order API | Create order → mock pay → status in DB; read `services/orders.ts` |
| 3. Web checkout | `/kitchen/csk-homemade-delights` → cart → pay → `/orders` |
| 4. Cook desk | `/cook/csk-homemade-delights` menu + cooking buttons |
| 5. WhatsApp | `/wa` customer + cook personas; read `parseWhatsAppIntent` |
| 6. Ops | [RUNBOOK.md](./RUNBOOK.md) cut-off, EOD, Mark paid |
| 7. Infra | [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) + Terraform README |

**Contribution rule of thumb**

```
adapters  = talk to vendors
domain    = rules that must never diverge by channel
services  = orchestration + DB + outbox
plugins   = HTTP only
web/wa    = presentation + intent
```

---

## 13. Implemented vs design-only (detail)

| Design mention | Repo reality | Guidance |
|----------------|--------------|----------|
| NestJS or Fastify | **Fastify only** | Don’t introduce Nest mid-MVP |
| Pub/Sub + Cloud Tasks | Outbox + worker + Scheduler | Add when volume/latency needs fan-out |
| PostGIS | Lat/lng + pin | Add when radius search becomes core |
| Exotel/Twilio IVR | Stub | Do not build until product asks |
| Shadowfax logistics | Stub | SELF delivery for MVP |
| Razorpay Route always on | Links + Mark paid fallback | Keep Admin payout path healthy |
| Full CQRS | Single Postgres model | Split read models only if desk/analytics hurt |

---

## Related docs

| Doc | When |
|-----|------|
| [HANDBOOK.md](./HANDBOOK.md) | Product + setup |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | API plugin map |
| [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) | Full C4 / long-term design |
| [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) | GCP / WA / Razorpay setup |
| [SECURITY.md](./SECURITY.md) | Auth & payment scope |
| [API.md](./API.md) | Route list |
| [RUNBOOK.md](./RUNBOOK.md) | Incidents & daily ops |
