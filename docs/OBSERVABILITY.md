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

## Support first (Admin) — then logs

For “where is my order / refund / WhatsApp?” start in **Admin → Orders**:

1. Paste **LM-…**, **checkout id**, **`trc_…`**, or Razorpay **txn id**.
2. Read the bundle: status, payments, **WhatsApp/outbox** (pending/failed), activity timeline.
3. Copy `traceId` from the card → Cloud Logging (filter is shown on the card).

Ledger events that matter for ops:

| `eventName` | Meaning |
|-------------|---------|
| `ORDER_*` / `CHILD_PAYS_REQUESTED` | Customer/cook journey on the order |
| `OUTBOX_NOTIFY_FAILED` | Worker could not send WA (flag off, allowlist, max retries) |
| `PAYMENT_CONFIRMING_STUCK` | Paid link open too long without webhook (deduped 6h) |
| `GATEWAY_*` | Raw payment webhook kinds |

## What a good log line looks like

Every meaningful line should include as many of these as known:

| Field | Purpose |
|-------|---------|
| `event` | Stable marker (`order.created`, `order.status_changed`, `order.paid`, `request.completed`, …) |
| `traceId` | One journey across API → Razorpay → logistics → worker |
| `publicId` / `checkoutId` | Customer-facing order keys |
| `customerMobile` | Masked (`+91***…`) |
| `cookSlug` / `cookId` | Kitchen |
| `status` / `fromStatus`/`toStatus` | Lifecycle |
| `amountPaise`, `mealType`, `serviceDate` | Money / slot |
| `method`/`url`/`statusCode`/`durationMs` | HTTP access (`request.completed`) |

**Noise control:** `/health`, `/meta/features`, `/meta/today` log at `debug` only. Fastify’s default “incoming request” lines are disabled.

Cloud Logging examples:

```text
jsonPayload.event="order.status_changed"
jsonPayload.traceId="trc_…"
jsonPayload.publicId="LM-…"
jsonPayload.event="request.completed" AND jsonPayload.statusCode>=400
jsonPayload.event="third_party.request"
jsonPayload.event="outbox.processed"
```

## Trace an order (ops) — prefer `traceId`

Each checkout/order gets one durable **`traceId`** (`trc_…`) at create time. It is:

- stored on `orders.trace_id`
- sent to Razorpay as payment-link / refund / transfer `notes.traceId` (comes back on webhooks)
- sent to partner logistics (Porter/Shadowfax gateway) as `traceId` + `metadata.traceId` on createShipment; webhook echoes it when the partner returns it (else we fall back to `orders.trace_id`)
- embedded on outbox `_corr.traceId`
- returned as response header **`X-Trace-Id`** (and in create/batch JSON when present)
- shown on Admin order support
- outbound calls also log `event=third_party.request` with the same `traceId`

`requestId` still changes on every HTTP call (including each webhook delivery). **Use `traceId` to join create → pay webhook → logistics webhook → outbox → worker.**

1. Get `traceId` from Admin order support, `X-Trace-Id`, or `publicId` if older rows were backfilled.
2. Cloud Logging:

```text
resource.type="cloud_run_revision"
jsonPayload.traceId="trc_…"
```

3. Fallback by order id:

```text
jsonPayload.publicId="LM-…"
```

OpenTelemetry (`OTEL_ENABLED=true`) is optional for latency/infra — **not** the primary support tool.

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

Set `alert_email` in tfvars (and optionally `alert_channels_extra` for SMS/PagerDuty/Slack channel IDs). Monitoring no longer requires `create_cloud_run=true` — set service names + public URLs instead:

| Variable | Default / example | Used for |
|----------|-------------------|----------|
| `api_service_name` | `localmeals-api` | 5xx + p95 latency filters |
| `web_service_name` | `localmeals-web` | Dashboard |
| `worker_service_name` | `localmeals-worker` | Dashboard |
| `api_url` | `https://….run.app` | Uptime + Scheduler base URL |
| `web_url` | `https://….run.app` | Web uptime |
| `alert_channels_extra` | `[]` | Appended to every policy |

Policies (each links a [RUNBOOK](./RUNBOOK.md) section in Monitoring documentation):

- API Cloud Run 5xx
- API request latency p95 > 2s for 10m
- Uptime (api `/health`, web `/`) when URLs are set
- Cloud SQL saturation (connections / CPU / disk)
- Scheduler lunch-cutoff / eod failures
- webhook signature failures (>3/min)
- outbox failures
- outbox oldest-pending age (`outbox_oldest_pending_age_sec` stub until worker emits `outbox.backlog`)
- WhatsApp send failures
- CONFIRMING_PAYMENT stuck
- EOD settlement.batch_failed
- Absence of `cutoff.reached` for 1h
- Absence of `settlement.batch_completed` (~25h; expect within 1h of EOD)

Dashboard: **LocalMeals ops** (request rate / 5xx / latency, Cloud SQL, outbox + webhook sig failures, scheduler attempts).

### Test-fire a policy

After apply, confirm channels receive mail and that log-based metrics increment:

```bash
# Fake payment.confirming_stuck → should trip "LocalMeals CONFIRMING_PAYMENT stuck"
gcloud logging write localmeals-alert-test \
  '{"message":"test-fire confirming stuck","event":"payment.confirming_stuck","severity":"WARNING"}' \
  --payload-type=json \
  --resource=cloud_run_revision \
  --project=home-food-513806

# Inspect the log-based metric (may take a minute to appear)
gcloud logging metrics describe localmeals-payment-confirming-stuck --project=home-food-513806
```

Note: `gcloud logging write` with `cloud_run_revision` may need resource labels (`service_name`, `revision_name`, `location`, `configuration_name`, `project_id`). If the write is rejected, use Logs Explorer → “Create log entry” on a real API revision, or temporarily lower the policy threshold and generate a real stuck-payment path in staging.

Other quick fires:

| Policy | Fake `jsonPayload.event` |
|--------|--------------------------|
| webhook signature | `webhook.signature_failed` (repeat >3/min) |
| outbox failures | `outbox.failed` |
| WA send | `whatsapp.send_failed` |
| EOD fail | `settlement.batch_failed` |

Uptime / 5xx / latency: stop the service briefly or force errors — do not disable prod carelessly. Scheduler: run a job with a bad token once in staging.

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
