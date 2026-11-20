# API architecture

For a full walkthrough (boot → every module → web/WA/pay flows), see **[CODE_TOUR.md](./CODE_TOUR.md)**.

LocalMeals API is a **modular monolith**: Fastify HTTP/WhatsApp wiring → `apps/api/src/services/*` → `@localmeals/domain` + `@localmeals/adapters`.

## Composition root

[`apps/api/src/app.ts`](../apps/api/src/app.ts) `buildApp()` only:

- Content-type parser (raw body for payment/WhatsApp HMAC)
- CORS, rate-limit (Postgres store), multipart, `/uploads` (local disk or GCS proxy when `GCS_UPLOADS_BUCKET` is set)
- Session `preHandler` + shared auth helpers ([`http/authContext.ts`](../apps/api/src/http/authContext.ts))
- Registers route plugins by bounded context

## Route plugins (`apps/api/src/plugins/`)

| Plugin | Surface |
|--------|---------|
| `metaRoutes` | `/health`, `/meta/*` |
| `authRoutes` | `/auth/*` |
| `customerRoutes` | `/me/*`, `/kitchens/*` browse, `/orders/*` customer, `/family/*`, `/checkouts/*`, `/cooks/apply` |
| `paymentRoutes` | `/payments/*`, payment webhooks |
| `cookRoutes` | `/cooks/:slug/*` desk mutators + desk reviews |
| `internalRoutes` | `/internal/*` |
| `adminRoutes` | `/admin/*` |
| `whatsappWebhook` | GET/POST `/webhooks/whatsapp` (verify + signature only) |

## WhatsApp intents (`apps/api/src/wa/`)

- `dispatch.ts` — `handleWhatsAppInbound` + **intent registry** (OCP: add intents to the map / group sets)
- `session.ts` — shared WA session helpers (`waSafe`, address resolve, menu send, place/late)
- `handlers/*` — language, cookOps, browse, help, orderFlow, pay, unknown

`waSafe` still converts handler errors into a customer WhatsApp reply (unchanged behavior).

## Uploads & observability

- **Uploads:** [`uploads.ts`](../apps/api/src/uploads.ts) writes to local `apps/api/uploads` by default. When `GCS_UPLOADS_BUCKET` is set, objects go to GCS and [`uploadsRoutes`](../apps/api/src/plugins/uploadsRoutes.ts) proxies `GET /uploads/:name` (public paths stay `/uploads/…`). Terraform: `infra/terraform/uploads_bucket.tf`.
- **Logging / correlation:** [`@localmeals/observability`](../packages/observability) — Cloud Logging–friendly JSON (`severity` + `message`), stable `event` markers, `X-Request-Id` on API, outbox `_corr` for worker join. See [OBSERVABILITY.md](./OBSERVABILITY.md).
- **OTel:** shared `startTelemetry` — set `OTEL_ENABLED=true` (+ optional `OTEL_EXPORTER_OTLP_ENDPOINT`) on API and worker. No-op when disabled.
- **Staging smoke:** `SMOKE_API_URL=… node scripts/smoke-staging.mjs`

## Deferred (not this seam cut)

Do **not** treat the plugin/WA split as “SOLID complete.” Still open:

- Pub/Sub / Cloud Tasks / fuller outbox consumer redesign
- CQRS / read models
- Carve [`services/orders.ts`](../apps/api/src/services/orders.ts) into smaller use-cases
- Trace dashboards / metrics exporters beyond log-based Cloud Monitoring

Next domain carve should keep HTTP plugins thin and move rules into services/use-cases, not grow `app.ts` again.
