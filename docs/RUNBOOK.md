# LocalMeals runbook

**Audience:** on-call / ops / whoever ships and keeps lunch running  
**Companion:** [HANDBOOK.md](./HANDBOOK.md) · [PENDING.md](./PENDING.md) · [MVP1_LAUNCH.md](./MVP1_LAUNCH.md)

Use this under pressure. Prefer **feature flags** and **Admin tools** before redeploying.

---

## 1. Service map

| Service | Role | Health / entry |
|---------|------|----------------|
| **Web** | Next.js UI | Public URL; proxies `/lm-api` → API |
| **API** | Sync HTTP + webhooks | `GET /health` → `{ ok: true }` |
| **Worker** | Outbox drain (WA, etc.) | Internal; needs ≥1 instance in prod |
| **Postgres** | Source of truth | Cloud SQL |
| **Scheduler** | Cut-off + EOD (+ optional retention) | Calls API with `X-Internal-Token` |
| **GCS** | Menu/concern photos | When `GCS_UPLOADS_BUCKET` set |

Staging URLs (current): see [MVP1_LAUNCH.md](./MVP1_LAUNCH.md).

---

## 2. Daily ops ritual (lunch pin)

1. **Before cut-off** — Admin → **Cooks**: LIVE kitchens have FSSAI + UPI; menus for today look right. Unpaid rows for **past service dates** auto-cancel (`expireUnpaidOrdersPastServiceDate` on My orders load + meal cut-off job).  
2. **Cut-off window** — Confirm Scheduler fired `POST /internal/cutoffs/LUNCH` (or cook WA Status still works for in-flight).  
3. **During service** — Cook desk / WA: cooking → packed → dispatch/deliver. **Cancel requests** (after cut-off): Accept = full refund, Decline = keep cooking. Tickets for disputes.  
4. **After delivery** — Admin → **Payouts**: after EOD, **Mark paid** + UTR if Route transfer not completing.  
5. **Analytics** — Admin → **Analytics**: week/month GMV if Route/RBI asks.  
6. **Incidents** — Admin → **Features**: turn off ordering / late / WA outbound / EOD as needed.

---

## 3. Scheduled jobs

| Job | When (IST) | Endpoint | Header |
|-----|------------|----------|--------|
| Lunch cut-off | ~08:00 (align to pin) | `POST /internal/cutoffs/LUNCH` | `X-Internal-Token: $INTERNAL_JOB_TOKEN` |
| EOD settlement | 18:00 | `POST /internal/settlements/eod` | same |
| Retention (optional) | daily / worker 03:00 | `POST /internal/ops/retention` | same |

**Manual EOD (Admin):** Admin → Payouts → **Run EOD**, or `POST /admin/settlements/run-eod` as admin session.

**Manual cut-off / EOD (curl):**

```bash
curl -sS -X POST "$API_URL/internal/cutoffs/LUNCH" \
  -H "X-Internal-Token: $INTERNAL_JOB_TOKEN"
curl -sS -X POST "$API_URL/internal/settlements/eod" \
  -H "X-Internal-Token: $INTERNAL_JOB_TOKEN"
```

If EOD flag is off: Admin → Features → `eod_settlement_enabled`.

---

## 4. Deploy & rollback

### Pre-deploy

- [ ] Migrations applied to **target** DB (through `0020_cancel_requested` as needed) — see [PENDING.md](./PENDING.md)  
- [ ] Secrets present in Secret Manager; Cloud Run mounts them  
- [ ] `GCS_UPLOADS_BUCKET` on API if multi-instance  
- [ ] CI green (`.github/workflows/ci.yml`)  

Checklist: [DEPLOY.md](./DEPLOY.md) · infra: [INFRASTRUCTURE.md](./INFRASTRUCTURE.md).

### Deploy

1. Build/push images (Artifact Registry) or GitHub **Deploy Cloud Run** (`ENABLE_GCP_DEPLOY=true`).  
2. Roll API → Worker → Web (or pipeline order).  
3. Smoke: `SMOKE_API_URL=$API_URL node scripts/smoke-staging.mjs`  
4. Spot-check: `/health`, login OTP/mock, one kitchen browse.

### Rollback

1. **Soft:** flip `ordering_enabled` off (stop new pain).  
2. Redeploy previous Cloud Run revision (API/web/worker).  
3. Do **not** reverse migrations casually — prefer forward fix.  
4. If payments broken: keep `MOCK_PAYMENTS=false` but pause ordering; do not leave prod on mocks.

---

## 5. Incident playbooks

### A. “Nobody can order”

| Check | Action |
|-------|--------|
| Admin Features → `ordering_enabled` | Turn on if accidentally off |
| API `/health` | If down → Cloud Run logs / revision / Cloud SQL |
| Cooks all paused / not LIVE | Admin → Cooks approve + UPI |
| Cut-off already passed | Late path needs `late_orders_enabled` + cook approve |

### B. Payments stuck / not PAID

| Check | Action |
|-------|--------|
| `MOCK_PAYMENTS` on prod | Must be `false`; mock-confirm returns 403 |
| Razorpay webhook URL + secret | Dashboard → `…/webhooks/payments`; secret matches SM |
| Events subscribed | `payment_link.paid`, `payment.captured`, failures, refunds |
| Order amount mismatch | 409 paths — check gateway amount vs order |
| API logs around webhook | HMAC failures → wrong `RAZORPAY_WEBHOOK_SECRET` |

Customer workaround: do not manually mark paid in DB; fix webhook then retry/reconcile via Razorpay dashboard + support ticket.

### C. WhatsApp silent / inbound broken

| Check | Action |
|-------|--------|
| `MOCK_WHATSAPP` | Prod `false`; local can stay `true` + `/wa` |
| Meta webhook verify | GET verify uses `WHATSAPP_VERIFY_TOKEN` |
| App secret / signature | Inbound POST HMAC with `WHATSAPP_APP_SECRET` |
| Access token expired | Rotate System User token → SM → sync Run |
| `whatsapp_outbound_enabled` | Flag off → no worker sends |
| Worker min instances | Must be ≥1 or outbox piles up |

Smoke: `node scripts/smoke-whatsapp.mjs`.

### D. Cut-off or EOD missed

1. Check Cloud Scheduler job history (Asia/Kolkata).  
2. Confirm `INTERNAL_JOB_TOKEN` matches Run env.  
3. Run curl from §3 manually.  
4. EOD: Admin **Run EOD** then **Mark paid** for cooks.  
5. Alert on next miss (5xx / Scheduler failure).

### E. Cook cannot go LIVE / accept paid orders

Domain gates: `onboardingStatus=LIVE`, `isActive`, FSSAI non-blank, payout UPI **or** bank note **or** Route `acc_…`.  
Whitespace-only UPI counts as missing. Admin → Cooks → payout details.

### F. Photos missing / 404 on `/uploads/…`

Multi-instance without GCS loses local disk files. Set `GCS_UPLOADS_BUCKET` (Terraform uploads bucket) and redeploy API.

### G. Settlements / Route blocked (RBI)

1. Run EOD anyway (creates settlement rows).  
2. Admin → Payouts → **Mark paid** + store UTR.  
3. Export turnover CSV (Analytics) for compliance asks.  
4. Route webhooks (`transfer.*`, `payout.*`) update status when unblocked.

### H. Abuse / bad kitchen / refund

- Admin tickets + refunds/holds (`/internal/ops/refunds`, holds, pause cook).  
- Pause cook: `POST /internal/ops/cooks/:id/pause` with internal token or Admin tools.  
- Feature-flag reviews/WA if spam wave.  
- **Already settled then refunded:** food amount → `cook_ledger` `CLAWBACK_PENDING` → next EOD nets `settlements.clawback_paise` (Admin Payouts shows recovery; cook desk shows pending). Customer refund is still platform Razorpay.

### I. High 5xx / rate-limit / DB

- Cloud Logging on API: Postgres / drizzle / ECONNREFUSED → 500.  
- Rate limit store is Postgres (`rate_limit_buckets`); prod fail-closed if store errors.  
- Scale Cloud Run / fix SQL connectivity / VPC connector.  
- Worker `CONNECT_TIMEOUT` /cloudsql: keep `DB_POOL_MAX` small (default 2 on worker); recycle via `idle_timeout`.  
- WA `#131030` (not in allowlist): outbox marks processed (non-retryable) — add test numbers in Meta or keep `MOCK_WHATSAPP=true` for non-pilot.  
- Razorpay `Order not found for txn`: API returns **200 ignored** so dashboard retries stop; investigate orphan plinks separately.

---

## 6. Webhooks (must stay green)

| Provider | URL | Auth |
|----------|-----|------|
| Razorpay | `https://$API/webhooks/payments` | HMAC `RAZORPAY_WEBHOOK_SECRET` |
| Meta WhatsApp | `https://$API/webhooks/whatsapp` | Verify token + app secret signature |

After URL or secret change: update dashboard **and** Secret Manager **and** Cloud Run revision.

---

## 7. Feature-flag kill switches

| Symptom | Flag to disable |
|---------|-----------------|
| Cascade order failures | `ordering_enabled` |
| Late-order spam / cook overload | `late_orders_enabled` |
| Family pay bugs | `child_pays_enabled` |
| Discount misprice | `week_discount_enabled` |
| Review abuse | `reviews_enabled` |
| WA send storm / Meta down | `whatsapp_outbound_enabled` |
| Bad EOD transfers | `eod_settlement_enabled` (then Mark paid manually) |
| Pickup confusion | `pickup_enabled` (default off) |

---

## 8. First LIVE cook checklist

- [ ] FSSAI number set  
- [ ] Payout UPI or bank note (Route optional)  
- [ ] `onboardingStatus=LIVE`, `isActive=true`  
- [ ] Menu + cut-off for lunch  
- [ ] Test order → pay → Status → deliver → EOD / Mark paid  
- [ ] Pickup only if pin ready + flag on  

---

## 9. Observability & smoke

| Check | Command / place |
|-------|-----------------|
| API up | `curl $API_URL/health` |
| Staging smoke | `SMOKE_API_URL=$API_URL node scripts/smoke-staging.mjs` |
| WA smoke | `node scripts/smoke-whatsapp.mjs` |
| Trace one order | Cloud Logging: `jsonPayload.traceId="trc_…"` (preferred) or `publicId` — [OBSERVABILITY.md](./OBSERVABILITY.md) |
| OTel (optional) | `OTEL_ENABLED=true` + OTLP endpoint on API + worker |
| Alerts | 5xx, Scheduler, webhook.signature_failed, outbox.failed, whatsapp.send_failed, payment.confirming_stuck, settlement.batch_failed |

---

## 10. Security ops

- Never set `MOCK_*=true` or default `AUTH_SECRET` in production (boot will refuse).  
- `AUTH_ENFORCE` must not be `false` in prod.  
- Rotate `INTERNAL_JOB_TOKEN`, WA token, Razorpay webhook secret via SM.  
- PCI: no card fields on LocalMeals — [SECURITY.md](./SECURITY.md).  
- DAST notes: [DAST.md](./DAST.md).  
- Payment **defensive** checks (not a hack kit): with API up, `python3 scripts/payment_security_probe.py`  
  For HMAC-hard assert set `MOCK_PAYMENTS=false`. In-process: `apps/api/src/security.test.ts`.  
  Broader scan: `npm run security:zap` (local/CI only — never aim at prod).

---

## 11. Escalation order

1. Feature flag / Admin Mark paid / pause cook  
2. Manual Scheduler curl  
3. Cloud Run previous revision  
4. Razorpay / Meta dashboard status  
5. Code fix + forward migration  

Open product/eng backlog: [PENDING.md](./PENDING.md).
