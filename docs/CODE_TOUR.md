# Code tour — how LocalMeals boots and runs

This is the **file-by-file / module-by-module** guide. Read it top-to-bottom once, then use the flow sections when debugging.

Companion docs (don’t duplicate here):

| Doc | Role |
|-----|------|
| [HANDBOOK.md](./HANDBOOK.md) | Product + roles + setup |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | API plugin layout (short) |
| [API.md](./API.md) | Route list |
| [TECH_STACK.md](./TECH_STACK.md) | Why each technology |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | Logs / `traceId` / Admin support |
| [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) | C4 / design goals |

---

## 1. Big picture

```text
Browser / Meta WhatsApp / Razorpay / Scheduler
        │
        ▼
   apps/web (Next.js :3000)          apps/api (Fastify :4000)
        │  /lm-api/* rewrite                │
        └──────────────►────────────────────┤
                                            │ services/* + wa/*
                                            │ same TX → outbox row
                                            ▼
                                     Postgres (@localmeals/db)
                                            │
                                            ▼
                                   apps/worker (poll outbox)
                                            │
                                            ▼
                                   WhatsApp / side effects
```

Three **long-running processes** locally:

| Process | Entry file | Port |
|---------|------------|------|
| API | `apps/api/src/index.ts` | `4000` (`API_PORT` / `PORT`) |
| Worker | `apps/worker/src/index.ts` | health `8080` (`PORT`) |
| Web | Next via `apps/web` (`npm run dev:web`) | `3000` |

Shared libraries live in `packages/*` and are imported as `@localmeals/…`.

---

## 2. Monorepo map

```text
localmeals/
├── apps/
│   ├── api/          Fastify HTTP + WhatsApp webhook + business services
│   ├── worker/       Outbox poller (+ stuck-payment scan, optional cron)
│   └── web/          Next.js App Router UI (customer, cook, admin, /wa sim)
├── packages/
│   ├── db/           Drizzle schema, migrations, seed, createDb()
│   ├── domain/       Pure rules: order states, cut-off, money, cook LIVE gates
│   ├── adapters/     Payments / WhatsApp / maps / logistics (mock or real)
│   ├── observability/ Pino JSON, LogEvent, traceId ALS, OTel bootstrap
│   └── i18n/         EN/TA copy for web + WA helpers
├── docs/             This handbook set
├── infra/terraform/  Cloud Run, Scheduler, alerts, uploads bucket
└── scripts/          smoke-*.mjs, security, secret sync
```

**Dependency rule (intended):**

```text
web ──HTTP──► api ──► domain + adapters + db + observability + i18n
worker ─────────────► adapters + db + observability (+ domain formatters)
```

Web never imports `apps/api` services. API never imports Next. Domain has **no** DB / Fastify / React.

---

## 3. How each process starts

### 3.1 API — beginning of the server

```text
apps/api/src/index.ts
  → ./env.js                 load .env
  → ./prodConfig.js          refuse unsafe prod config
  → ./telemetry.js           optional OTEL (OTEL_ENABLED)
  → ./app.js buildApp()
  → app.listen(:4000)
```

**`buildApp()`** (`apps/api/src/app.ts`) is the composition root. In order:

1. Create Fastify + Pino logger (`@localmeals/observability`)
2. `registerObservability` — `X-Request-Id` / `X-Trace-Id`, bind ALS
3. `registerApiErrorHandler` — map thrown errors → JSON `{ error }`
4. Raw JSON body parser — keep `rawBody` for Razorpay / Meta HMAC
5. CORS (web origin + extras)
6. Global rate limit (Postgres store)
7. **`registerSessionHook`** — every request: parse `lm_session` / Bearer → `req.sessionUser`
8. Multipart + `/uploads` (disk or GCS proxy)
9. **Register route plugins** with `{ db, auth }`:

| Plugin file | Mounts |
|-------------|--------|
| `plugins/metaRoutes.ts` | `/health`, `/meta/*` |
| `plugins/authRoutes.ts` | `/auth/*` OTP login |
| `plugins/customerRoutes.ts` | kitchens, orders, checkouts, me, family |
| `plugins/paymentRoutes.ts` | pay confirm + `/webhooks/payments` |
| `plugins/cookRoutes.ts` | cook desk `/cooks/:slug/*` |
| `plugins/internalRoutes.ts` | cut-off, EOD, retention (`X-Internal-Token`) |
| `plugins/adminRoutes.ts` | admin tickets, cooks, order support, analytics |
| `plugins/whatsappWebhook.ts` | `/webhooks/whatsapp` |
| `plugins/logisticsWebhook.ts` | partner delivery webhooks |

**HTTP layer pattern:** plugin = thin Zod + auth assert → call `services/*` → return JSON. Business rules live in services / domain, not in the route file.

### 3.2 Worker — async side effects

```text
apps/worker/src/index.ts
  → dotenv
  → startTelemetry("localmeals-worker")
  → createDb()
  → setInterval(3s):
        processOutbox()
        maybeRunScheduled()   # optional cut-off / EOD / retention HTTP to API
        scanStuckConfirmingPayments()  # every ~60s
  → HTTP health on :8080
```

`processOutbox()`:

1. Load unprocessed `outbox` rows  
2. Switch on `eventName` (`OrderCreated`, `OrderPaid`, `OrderCancelled`, …)  
3. Call `getWhatsAppProvider().send(...)`  
4. Mark `processedAt` or bump `attempts` / `lastError`  
5. On terminal failure → `opsLedger.recordOutboxOpsFailure` (order activity timeline)

Correlation: each outbox payload has `_corr` (`traceId`, `requestId`, …) from `enqueueOutbox` → `withCorr` in observability.

### 3.3 Web — Next.js

```text
npm run dev -w @localmeals/web
  → Next loads apps/web
  → middleware.ts (CSP, soft auth gate, solo-kitchen redirect)
  → app/layout.tsx (LocaleProvider, AuthProvider, chrome)
  → app/page.tsx or route pages under app/
```

**Calling the API from the browser**

```text
Component / page
  → lib/auth.ts authFetch() or lib/api.ts api()
  → fetch("/lm-api/…")          # browser (first-party cookie)
  → next.config.ts rewrite
  → http://127.0.0.1:4000/…     # Fastify
```

**SSR / Server Components:** `api.ts` uses `API_INTERNAL_URL` and **forwards** the request `Cookie` header so `lm_session` still authenticates.

Protected soft-gates in `middleware.ts`: ops console path (`NEXT_PUBLIC_ADMIN_PATH`, default `/lm-ops-k7v2m9`), `/cook`, `/orders`, `/account`, `/family` (except `/cook/onboard`). Guessable `/admin` UI returns 404. Real authorization is always on the API.

---

## 4. Shared packages (what each module is for)

### 4.1 `@localmeals/db` — `packages/db`

| File | Purpose |
|------|---------|
| `src/schema.ts` | All tables: users, cook_profiles, menu_items, orders, payments, outbox, platform_event_ledger, settlements, tickets, … |
| `src/client.ts` | `createDb(DATABASE_URL)` Drizzle + postgres.js |
| `src/migrate.ts` | Apply SQL migrations |
| `src/seed.ts` | Demo cook/customer/menu for local |

**Orders** carry `publicId` (`LM-…`), `checkoutId` (week cart), `traceId` (`trc_…`), `channel` (`WEB_STOREFRONT` \| `WHATSAPP_BOT` \| …).

### 4.2 `@localmeals/domain` — pure rules

| File | Purpose |
|------|---------|
| `orderState.ts` | Allowed status transitions (`assertTransition`) |
| `cutoff.ts` | Per-cook lunch cut-off helpers |
| `cookGates.ts` | LIVE + FSSAI + payout required to sell |
| `money.ts` | Line totals, platform fee helpers |
| `weekDiscount.ts` | Optional N+ day % off food |
| `checkoutStatus.ts` | Aggregate status for multi-day checkout |
| `fulfillment.ts` | Delivery vs pickup modes |
| `orderPaidNotify.ts` | WA copy templates for paid notify |
| `featureFlags.ts` | Flag key constants / defaults |
| `reviews.ts` | Review eligibility rules (MVP-2) |

Import these from services; **do not** put HTTP or SQL here.

### 4.3 `@localmeals/adapters` — I/O boundaries

| File | Purpose |
|------|---------|
| `payments.ts` | `getPaymentProvider()` — mock links or Razorpay Payment Links |
| `whatsapp.ts` | `getWhatsAppProvider()` — mock inbox or Meta Cloud API |
| `maps.ts` | Route / Maps URL helpers for cook desk |
| `logistics.ts` | Partner delivery HTTP (Shadowfax-ready mock) |
| `ivr.ts` | Stub only (not MVP-1) |

Env flags: `MOCK_PAYMENTS`, `MOCK_WHATSAPP` switch implementations.

### 4.4 `@localmeals/observability`

| File | Purpose |
|------|---------|
| `logger.ts` | Pino JSON for Cloud Logging |
| `events.ts` | Stable `LogEvent.*` strings for alerts |
| `context.ts` | AsyncLocalStorage: `traceId`, `requestId`, `withCorr` for outbox |
| `telemetry.ts` | Optional OpenTelemetry |

### 4.5 `@localmeals/i18n`

| File | Purpose |
|------|---------|
| `modules.ts` | EN + TA string catalogs (web `t("…")`) |
| `waFlow.ts` | WA-oriented helpers / labels |
| `locales.ts` | Locale type |

Web rebuilds via `npm run build -w @localmeals/i18n` when catalogs change.

---

## 5. API modules in detail

### 5.1 Auth path

```text
POST /auth/otp/request  → services/auth.ts  → (WA OTP in prod; mock codes locally)
POST /auth/otp/verify   → sets HttpOnly cookie lm_session
GET  /auth/me           → session user
```

`http/authContext.ts`:

- `preHandler` loads session on every request  
- `assertAuthed(req, ["ADMIN"])` etc.  
- `bindCustomerMobile(req)` — HTTP creates always use signed-in customer mobile (anti-spoof)

### 5.2 Customer order path (web)

Typical **single-day lunch**:

```text
1. GET  /kitchens/:slug              customerRoutes → cook public DTO + menu
2. POST /orders                      → services/orders.createOrder
         │
         ├─ domain cookGates + cutoff + money
         ├─ insert orders (AWAITING_PAYMENT) + payments CREATED
         ├─ platform_event_ledger ORDER_CREATED
         ├─ enqueueOutbox OrderCreated (+ ChildPaysRequested if family pays)
         └─ return { publicId, paymentUrl, traceId, … }

3. Browser → /pay/[publicId]         web pay page
4. User pays (Razorpay or mock)
5. POST /webhooks/payments           paymentRoutes → paymentWebhooks
         │
         └─ markOrderPaid → PAID + OrderPaid outbox + ledger ORDER_PAID

6. Worker sends WA to cook + customer
7. Cook advances COOKING → PACKED → DISPATCHED → DELIVERED
         (web cook desk or WA cookOps → cookOps / transitionOrder)
```

**Week cart:**

```text
POST /orders/batch  → createBatchOrders (one checkoutId, shared gatewayTxnId)
GET  /checkouts/:id → aggregateCheckoutStatus (domain)
POST /checkouts/:id/cancel → cancelCheckout (each day line)
```

### 5.3 Services catalog (`apps/api/src/services/`)

| Module | Responsibility |
|--------|----------------|
| `orders.ts` | Create / pay / cancel / late / transition / batch — **largest** |
| `orderActivity.ts` | Ledger write + Admin support bundle (lookup by LM / checkout / trc / txn) |
| `cookOps.ts` | Menu, cut-off lock, kitchen status batch, pause cook |
| `auth.ts` | OTP, sessions, roles |
| `addresses.ts` | Customer HOME/OFFICE/OTHER |
| `profile.ts` | `/me` profile + consents |
| `kitchenFollow.ts` | Follow kitchen + menu WA consent |
| `family.ts` | Child Pays link request |
| `paymentWebhooks.ts` | Razorpay event → mark paid / refund / payout hooks |
| `admin.ts` | Refunds, tickets, cook approve, mark settlement paid |
| `settlement.ts` | EOD batch |
| `cookClawback.ts` | Post-refund clawback notes |
| `featureFlags.ts` | Kill switches |
| `outboxEnqueue.ts` | Insert outbox + `_corr` |
| `partnerLogistics.ts` | Dispatch via partner when cook deliveryType=PARTNER |
| `reviews.ts` | Post-delivery reviews |
| `retention.ts` | PII / ephemeral purge |
| `waSession.ts` | Persist WA conversation locale / draft bits |
| `getTurnoverReport.ts` / `turnoverReports.ts` | Admin analytics |
| `cookApply.ts` | Public cook enrollment |
| `internalAuth.ts` | Validate `X-Internal-Token` |
| `pgRateLimitStore.ts` | Distributed rate limits |

### 5.4 WhatsApp inbound path

```text
POST /webhooks/whatsapp
  plugins/whatsappWebhook.ts
    → verify signature (prod) / accept mock body
    → extractInboundWhatsApp (adapters)
    → wa/dispatch.handleWhatsAppInbound
         → wa/session.createWaSession  (parse intent, locale, helpers)
         → resolveHandler(intent)
         → handlers/*
```

| Handler | Intents (examples) |
|---------|-------------------|
| `language.ts` | LANGUAGE |
| `help.ts` | HELP |
| `browse.ts` | MENU, PICK, ADDRESSES, SAVE_ADDRESS |
| `orderFlow.ts` | ORDER, WEEK, CANCEL, FOLLOW, ORDERS, LATE |
| `pay.ts` | PAY |
| `cookOps.ts` | Cooking / Packed / Dispatched / Delivered / late / cancel accept |
| `familyReview.ts` | FAMILY*, REVIEW |
| `unknown.ts` | fallback |

Handlers call the **same** `services/*` as HTTP (shared fees, cancel rules, Follow consent). Channel is usually `WHATSAPP_BOT`.

Simulator UI: `apps/web/src/app/wa/page.tsx` → POST mock webhook body.

### 5.5 Payments webhook path

```text
POST /webhooks/payments
  paymentRoutes
    → verify Razorpay signature (rawBody)
    → paymentWebhooks.handle…
         → markOrderPaid / refund paths
         → ledger GATEWAY_*
         → enqueue outbox as needed
```

Mock local: `POST /payments/mock-confirm` (blocked when `MOCK_PAYMENTS=false`).

### 5.6 Internal / Scheduler path

```text
Cloud Scheduler (or worker maybeRunScheduled)
  → POST /internal/cutoffs/LUNCH     + X-Internal-Token
  → POST /internal/settlements/eod
  → POST /internal/ops/retention
```

Implemented in `plugins/internalRoutes.ts` → `cookOps` / `settlement` / `retention`.

---

## 6. Web modules in detail

### 6.1 App routes (`apps/web/src/app/`)

| Route | Who | Talks to API |
|-------|-----|--------------|
| `/` | Landing / solo redirect | kitchens list or solo slug |
| `/discover` | Marketplace browse | kitchens |
| `/kitchen/[slug]` | Customer menu + cart | menu, create order/batch |
| `/pay/[publicId]` | Pay UX | order + payment URL |
| `/order/confirmed/[publicId]` | Post-pay status | checkout/order aggregate |
| `/orders` | My orders | list + cancel |
| `/account` | Profile / addresses | `/me`, addresses |
| `/family` | Child Pays links | `/family/*` |
| `/login` | OTP | `/auth/*` |
| `/cook/[slug]` | Cook desk | `/cooks/:slug/*` |
| `/cook/onboard` | Apply | cook apply |
| `/lm-ops-k7v2m9` (UI) | Ops | API `/admin/*` (support lookup, payouts, flags) |
| `/wa` | WA simulator | `/webhooks/whatsapp` mock |

### 6.2 Lib / components

| Path | Role |
|------|------|
| `lib/api.ts` | `api()` fetch helper + SSR cookie forward |
| `lib/auth.ts` | `authFetch`, session helpers |
| `lib/payments.ts` | Open payment URL / mock confirm |
| `lib/soloKitchen.ts` | Solo launch overlay (`NEXT_PUBLIC_SOLO_KITCHEN_SLUG`) |
| `lib/orderStatus.ts` | Display helpers for statuses |
| `lib/fulfillment.ts` | Delivery vs pickup UI |
| `lib/locale.ts` | Locale cookie / header |
| `lib/features.ts` | Feature flag client reads |
| `components/AuthProvider.tsx` | Session context |
| `components/LocaleProvider.tsx` | `t()` i18n |
| `components/RequireAuth.tsx` | Client role gate |
| `components/CancelOrderButton.tsx` | Cancel / refund UX |
| `components/CheckoutAddressPicker.tsx` | Address on checkout |

---

## 7. End-to-end flows (follow the code)

### 7.1 Happy path: place → pay → deliver (web)

```text
KitchenBrowse / OrderForm
  → POST /orders or /orders/batch          customerRoutes
  → orders.createOrder / createBatchOrders
  → adapters payments.createPayment
  → DB orders + payments + ledger + outbox
  → JSON { paymentUrl, publicId, traceId }

Pay page
  → user completes UPI (or mock-confirm)

Webhook or mock
  → markOrderPaid
  → status PAID, OrderPaid outbox

Worker
  → WA cook + customer

Cook desk or WA "Cooking" / "Packed" / …
  → cookOps.advanceOrderKitchenStatus / mark*
  → transitionOrder (domain assertTransition)
  → OrderStatusChanged outbox → worker WA customer
```

### 7.2 Cancel before cut-off (paid)

```text
CancelOrderButton or WA CANCEL
  → cancelOrder({ channel })
  → refundOrder (admin service) if PAID before cut-off
  → mode "refunded"
  → OrderCancelled / OrderRefunded outbox
  → worker WA: refund hours copy
```

After cut-off: `CANCEL_REQUESTED` → cook Accept/Decline on WA or desk.

### 7.3 Ops support lookup

```text
Admin → Orders tab
  → GET /admin/orders/:key
  → orderActivity.getOrderSupportBundle
       resolve: publicId | checkoutId | traceId | gatewayTxnId
       returns: order, payments, outbox, activity, cloudLogging filter
```

### 7.4 Feature flags / kill switches

```text
DB feature_flags (+ services/featureFlags.ts)
  → Admin Features tab toggles
  → ordering_enabled, whatsapp_outbound_enabled, late_orders_enabled, eod_settlement_enabled, …
Worker checks whatsapp_outbound_enabled before send
```

---

## 8. Data that ties journeys together

| Field | Where | Use |
|-------|--------|-----|
| `orders.publicId` | Customer-facing | Support, WA buttons `Pay LM-…` |
| `orders.checkoutId` | Week cart | Batch pay / cancel week |
| `orders.traceId` | Create time | Logs + Razorpay notes + Admin |
| `outbox.payload._corr` | enqueueOutbox | Worker log join |
| `platform_event_ledger` | Activity | Admin timeline |
| `payments.gatewayTxnId` | Charge / refund | Webhook match |

---

## 9. Suggested reading order (new engineer)

1. This file (§1–3)  
2. `apps/api/src/app.ts` + one plugin (`customerRoutes.ts`)  
3. `packages/domain/src/orderState.ts` + `money.ts`  
4. `services/orders.ts` — `createOrder` + `markOrderPaid` + `cancelOrder`  
5. `wa/dispatch.ts` + `handlers/orderFlow.ts`  
6. `apps/worker/src/index.ts` (one event handler)  
7. `apps/web/src/lib/api.ts` + `kitchen/[slug]/KitchenBrowse.tsx`  
8. [OBSERVABILITY.md](./OBSERVABILITY.md) + Admin Orders tab  

When adding a feature:

1. Domain rule (if pure) → `packages/domain`  
2. Persist / orchestrate → `apps/api/src/services/…`  
3. Expose → thin plugin route **and/or** WA handler  
4. Async notify → `enqueueOutbox` + worker case  
5. UI → `apps/web` using `authFetch` / `api`  
6. Ledger row if ops will ask “what happened?”

---

## 10. What not to confuse

| Looks like | Actually |
|------------|----------|
| Web “API” in `lib/api.ts` | Just an HTTP client to Fastify |
| `/wa` page | Simulator; real Meta hits API webhook |
| Worker “API” calls | Optional internal HTTP for cut-off/EOD; primary work is DB outbox |
| `MOCK_*` | Local adapters — prod must be `false` for live pay/WA |
| OTel | Optional latency traces — ops support uses ledger + `traceId` logs |

---

## 11. File cheat-sheet (open these first)

| Question | Open |
|----------|------|
| How does the server start? | `apps/api/src/index.ts`, `app.ts` |
| Where is this HTTP route? | `apps/api/src/plugins/*.ts` + [API.md](./API.md) |
| Where is order business logic? | `apps/api/src/services/orders.ts` |
| Where are status rules? | `packages/domain/src/orderState.ts` |
| How does WhatsApp parse text? | `apps/api/src/wa/dispatch.ts`, `session.ts` |
| How does pay confirm land? | `services/paymentWebhooks.ts` |
| How does a message leave the system? | `services/outboxEnqueue.ts` → `apps/worker/src/index.ts` |
| How does the browser reach the API? | `apps/web/src/lib/api.ts`, `next.config.ts` |
| How do I debug one order? | Admin Orders + [OBSERVABILITY.md](./OBSERVABILITY.md) |
| High-risk flow tests? | `apps/api/src/opsFlows.e2e.test.ts` (outbox drain, week cancel, cancel-request, Child Pays, Admin lookup) |
