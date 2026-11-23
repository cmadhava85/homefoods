# API architecture

For a full walkthrough (boot → every module → web/WA/pay flows), see **[CODE_TOUR.md](./CODE_TOUR.md)**.

LocalMeals API is a **modular monolith**: Fastify HTTP/WhatsApp wiring → `apps/api/src/services/*` → `@localmeals/domain` + `@localmeals/adapters`.

## Composition root

[`apps/api/src/app.ts`](../apps/api/src/app.ts) `buildApp()` only:

- Content-type parser (raw body for payment/WhatsApp/logistics HMAC)
- CORS, rate-limit (Postgres store; fail-closed in production), multipart
- `/uploads` — local disk (`@fastify/static`) or GCS proxy via [`uploadsRoutes`](../apps/api/src/plugins/uploadsRoutes.ts) when `GCS_UPLOADS_BUCKET` is set
- Session `preHandler` + shared auth helpers ([`http/authContext.ts`](../apps/api/src/http/authContext.ts))
- Observability plugin (`X-Request-Id` / `X-Trace-Id`) + unified error handler
- Registers route plugins by bounded context

## Route plugins (`apps/api/src/plugins/`)

| Plugin | Surface |
|--------|---------|
| `metaRoutes` | `/health`, `/meta/*` (today, features) |
| `authRoutes` | `/auth/*` |
| `customerRoutes` | `/me/*`, `/kitchens/*`, `/orders/*`, `/checkouts/*`, `/family/*`, `/ads`, reviews/concerns, `/cooks/apply` |
| `paymentRoutes` | `/payments/*`, `/webhooks/payments` |
| `cookRoutes` | `/cooks/:slug/*` desk (menu, pipeline, late/cancel, boosts, reviews) |
| `internalRoutes` | `/internal/*` (cut-offs, EOD, retention, ops; token / staff) |
| `adminRoutes` | `/admin/*` (tickets, cooks, payouts, features, ads, order support, analytics) |
| `whatsappWebhook` | GET/POST `/webhooks/whatsapp` (verify + signature only → `wa/dispatch`) |
| `logisticsWebhook` | POST `/webhooks/logistics` (partner shipment status; see [LOGISTICS.md](./LOGISTICS.md)) |
| `uploadsRoutes` | `GET /uploads/:name` when GCS is enabled (else static disk mount) |

**HTTP pattern:** plugin = thin Zod + auth assert → `services/*` → JSON. Cut-off, money, and state rules stay in domain/services.

## WhatsApp intents (`apps/api/src/wa/`)

- `dispatch.ts` — `handleWhatsAppInbound` + **intent registry** (OCP: add intents to the map / group sets)
- `session.ts` — shared WA session helpers (`waSafe`, address resolve, menu send, place/late)
- `handlers/*` — language, cookOps, browse, help, orderFlow, pay, **familyReview**, unknown

`waSafe` still converts handler errors into a customer WhatsApp reply (unchanged behavior).

## Key services (not exhaustive)

| Area | Modules |
|------|---------|
| Orders / money | `orders.ts`, `paymentWebhooks.ts`, `settlement.ts`, `cookClawback.ts` |
| Ops audit | `orderActivity.ts` (ledger + Admin support bundle), `outboxEnqueue.ts` |
| Cook desk | `cookOps.ts`, `reviews.ts`, `ads.ts` (gated by `ads_enabled`, default **OFF**) |
| Platform | `featureFlags.ts`, `admin.ts`, `retention.ts`, `partnerLogistics.ts` |

Worker drains transactional outbox → WhatsApp (and related side effects). See [CODE_TOUR.md](./CODE_TOUR.md) §3.2.

## Uploads & observability

- **Uploads:** [`uploads.ts`](../apps/api/src/uploads.ts) writes to local `apps/api/uploads` by default. When `GCS_UPLOADS_BUCKET` is set, objects go to GCS and [`uploadsRoutes`](../apps/api/src/plugins/uploadsRoutes.ts) proxies `GET /uploads/:name` (public paths stay `/uploads/…`). Terraform: `infra/terraform/uploads_bucket.tf`.
- **Logging / correlation:** [`@localmeals/observability`](../packages/observability) — Cloud Logging–friendly JSON (`severity` + `message`), stable `event` markers, `X-Request-Id` on API, outbox `_corr` for worker join. Durable journey id: `orders.traceId` (`trc_…`). See [OBSERVABILITY.md](./OBSERVABILITY.md).
- **OTel:** shared `startTelemetry` — set `OTEL_ENABLED=true` (+ optional `OTEL_EXPORTER_OTLP_ENDPOINT`) on API and worker. No-op when disabled.
- **Staging smoke:** `SMOKE_API_URL=… node scripts/smoke-staging.mjs`

## Deferred (not this seam cut)

Do **not** treat the plugin/WA split as “SOLID complete.” Still open:

- Pub/Sub / Cloud Tasks / fuller outbox consumer redesign (worker interval + DB outbox is live today)
- CQRS / read models / full event sourcing (ops audit timeline is **order-centric ledger**, not a replay store)
- Carve [`services/orders.ts`](../apps/api/src/services/orders.ts) into smaller use-cases
- Trace dashboards / metrics exporters beyond log-based Cloud Monitoring
- Live ads monetization (schema + Admin/Discover/cook surfaces exist; keep `ads_enabled` **OFF** until pin volume is healthy)

Next domain carve should keep HTTP plugins thin and move rules into services/use-cases, not grow `app.ts` again.
