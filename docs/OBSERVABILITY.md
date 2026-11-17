# Production observability

How to debug money, WhatsApp, and cut-off/EOD issues in staging/prod.

## Stack

| Piece | Role |
|-------|------|
| **Pino JSON** (`severity` + `message`) | Cloud Logging on Cloud Run stdout |
| **`event` field** | Stable markers for log-based metrics / alerts |
| **`traceId` / `X-Trace-Id`** | One payment/order journey across webhooks + worker |
| **`requestId` / `X-Request-Id`** | One HTTP request (new per webhook delivery) |
| **Outbox `_corr`** | Carries `traceId` + `requestId` into the worker |
| **`publicId` / `checkoutId`** | Customer-facing order keys in logs |
| **OpenTelemetry** | Optional traces (`OTEL_ENABLED=true`) |

Package: [`packages/observability`](../packages/observability).

## Trace an order (ops) — prefer `traceId`

Each checkout/order gets one durable **`traceId`** (`trc_…`) at create time. It is:

- stored on `orders.trace_id`
- sent to Razorpay as payment-link `notes.traceId` (comes back on webhooks)
- embedded on outbox `_corr.traceId`
- returned as response header **`X-Trace-Id`** (and in create/batch JSON when present)

`requestId` still changes on every HTTP call (including each webhook delivery). **Use `traceId` to join create → pay webhook → outbox → worker.**

1. Get `traceId` from Admin/order JSON, `X-Trace-Id`, or `publicId` if older rows were backfilled.
2. Cloud Logging:

```text
resource.type="cloud_run_revision"
jsonPayload.traceId="trc_…"
```

3. Fallback by order id:

```text
jsonPayload.publicId="LM-…"
```

## Stable `event` values

| `event` | Meaning |
|---------|---------|
| `webhook.signature_failed` | Razorpay or Meta HMAC rejected |
| `webhook.handler_failed` | Webhook accepted sig but handler threw |
| `outbox.processed` | Worker finished an outbox row |
| `outbox.failed` | Worker handler error (retries via `attempts`) |
| `outbox.skipped` | Feature flag / missing mobile |
| `whatsapp.send_failed` | Provider send threw |
| `payment.confirming_stuck` | Order in `CONFIRMING_PAYMENT` too long (default 15m) |
| `cutoff.reached` | Meal cut-off lock |
| `settlement.batch_completed` | EOD batch OK path |
| `settlement.batch_failed` | Transfer failed / missing payout account |
| `order.created` | Order/checkout created (includes `traceId`) |
| `request.completed` | Request finished after `bindTrace` (includes `traceId`) |
| `request.failed` | API error handler |
| `worker.started` | Worker boot |

**E2E:** `apps/api/src/customerJourney.e2e.test.ts` asserts place → pay → deliver and that `X-Trace-Id`, DB, outbox `_corr`, and log lines share one `traceId`.

Do **not** rename these without updating `infra/terraform/monitoring.tf`.

## Alerts (Terraform)

Set `alert_email` in tfvars. Policies:

- API Cloud Run 5xx
- Scheduler lunch-cutoff / eod failures
- webhook signature failures (>3/min)
- outbox failures
- WhatsApp send failures
- CONFIRMING_PAYMENT stuck
- EOD settlement.batch_failed

## Env

| Variable | Default | Notes |
|----------|---------|-------|
| `LOG_LEVEL` | `info` | API + worker |
| `OTEL_ENABLED` | `false` | Traces when `true` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | SDK default | Collector URL |
| `CONFIRMING_STUCK_MS` | `900000` | Worker stuck-payment scan |

## Local

```bash
npm run build -w @localmeals/observability
# optional traces
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces npm run dev:api
```
