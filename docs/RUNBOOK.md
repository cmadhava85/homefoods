# LocalMeals runbook

**Audience:** on-call / ops / whoever ships and keeps lunch running  
**Companion:** [HANDBOOK.md](./HANDBOOK.md) · [PENDING.md](./PENDING.md) · [MVP1_LAUNCH.md](./MVP1_LAUNCH.md)

Use this under pressure. Prefer **feature flags** and **Admin tools** before redeploying.

## Solo launch go-live (short)

1. Commit + push → wait for CI.
2. Deploy Cloud Run (api / web / worker) with solo slug env set.
3. Smoke: CSK kitchen → address → pay → cook desk → deliver.
4. WhatsApp: your Meta test number → inbound menu / status ping.
5. Admin → Features: leave **Self delivery fee** and **Delivery distance limits** OFF until ready; use Features to kill ordering if needed.

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
| EOD settlement | 21:00 | `POST /internal/settlements/eod` | same |
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

- [ ] New migrations are **backward compatible** with the revision still serving (expand → deploy → contract: add nullable columns/tables first, drop or rename only in a later release)  
- [ ] Secrets present in Secret Manager; Cloud Run mounts them  
- [ ] `GCS_UPLOADS_BUCKET` on API if multi-instance  
- [ ] CI green (`.github/workflows/ci.yml`)  

Checklist: [DEPLOY.md](./DEPLOY.md) · infra: [INFRASTRUCTURE.md](./INFRASTRUCTURE.md).

### Deploy (GitHub **Deploy Cloud Run**, `ENABLE_GCP_DEPLOY=true`)

The pipeline does, in order (a failed step stops the deploy; earlier revisions keep serving):

1. Build/push `api`, `worker`, `web` images tagged with the commit SHA.  
2. **Migrate:** Cloud Run Job `localmeals-migrate` (API image, `node /app/packages/db/dist/migrate.js`, `--wait`). Failure → deploy stops before any service changes.  
3. **API:** deployed with `--no-traffic --tag=candidate`; `scripts/smoke-staging.mjs` runs against the candidate URL; only on success is traffic moved (`--to-latest`) and the tag removed.  
4. **Worker:** deployed after the API is promoted (it calls the API's internal routes).  
5. **Web:** same candidate → smoke (`/`, `/legal/terms`, 404 page) → promote flow.

Manual migration (if ever needed): `gcloud run jobs execute localmeals-migrate --region=$REGION --wait`.

### Rollback

1. **Soft:** flip `ordering_enabled` off (stop new pain).  
2. **Traffic rollback (seconds):**  
   ```bash
   gcloud run revisions list --service=localmeals-api --region=$REGION --limit=5
   gcloud run services update-traffic localmeals-api --region=$REGION --to-revisions=<PREVIOUS_REVISION>=100
   ```  
   Same for `localmeals-web`. Worker has no traffic split: `gcloud run deploy localmeals-worker --image=<REGISTRY>/worker:<PREVIOUS_SHA>`.  
3. Do **not** reverse migrations casually — prefer forward fix (old revisions keep working because migrations are expand-only).  
4. If payments broken: keep `MOCK_PAYMENTS=false` but pause ordering; do not leave prod on mocks.  
5. Data loss / bad migration: see **§13 Database restore (PITR)**.

### Graceful shutdown

API and worker handle `SIGTERM` (Cloud Run scale-down / new revision): the API stops accepting connections and finishes in-flight requests; the worker stops polling, lets the current outbox batch finish (unfinished rows are re-claimed after `OUTBOX_LEASE_SEC`), then both close the DB pool and flush traces — bounded to 8 s. An `uncaughtException` now **exits 1** after the same cleanup so Cloud Run replaces the instance (previously it was logged and the process kept running in an unknown state).

---

## 5. Order support lookup (first tool)

Admin → **Orders** → paste any of:

| Key | Example |
|-----|---------|
| publicId | `LM-…` |
| checkoutId | week cart id |
| traceId | `trc_…` |
| gatewayTxnId | Razorpay payment / link id |

Bundle shows status, address, payments, **outbox** (WA notify pending/failed), activity, and a Cloud Logging filter.

| Symptom | Where to look |
|---------|----------------|
| Paid but cook quiet | Outbox `OrderPaid` failed / `OUTBOX_NOTIFY_FAILED` + Meta allowlist |
| Refund unclear | Activity `ORDER_REFUNDED` + payments REFUND row |
| UPI paid, still CONFIRMING | Activity `PAYMENT_CONFIRMING_STUCK` + Razorpay webhook §B |
| Child Pays waiting | `CHILD_PAYS_REQUESTED` + payer mobile on card |

Full log join: [OBSERVABILITY.md](./OBSERVABILITY.md).

---

## 6. Incident playbooks

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
- Route rate limits (OTP, login, orders) use Postgres (`rate_limit_buckets`), fail-closed in prod; the global per-IP limit is in memory per instance.  
- Scale Cloud Run / fix SQL connectivity (Cloud SQL connector: service account needs `roles/cloudsql.client`; no VPC connector is used).  
- Worker `CONNECT_TIMEOUT` /cloudsql: keep `DB_POOL_MAX` small (default 2 on worker); recycle via `idle_timeout`.  
- WA `#131030` (not in allowlist): outbox marks processed (non-retryable) — add test numbers in Meta or keep `MOCK_WHATSAPP=true` for non-pilot.  
- Razorpay `Order not found for txn`: API returns **200 ignored** so dashboard retries stop; investigate orphan plinks separately.

---

## 7. Webhooks (must stay green)

| Provider | URL | Auth |
|----------|-----|------|
| Razorpay | `https://$API/webhooks/payments` | HMAC `RAZORPAY_WEBHOOK_SECRET` |
| Meta WhatsApp | `https://$API/webhooks/whatsapp` | Verify token + app secret signature |

After URL or secret change: update dashboard **and** Secret Manager **and** Cloud Run revision.

---

## 8. Feature-flag kill switches

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

## 9. First LIVE cook checklist

- [ ] FSSAI number set  
- [ ] Payout UPI or bank note (Route optional)  
- [ ] `onboardingStatus=LIVE`, `isActive=true`  
- [ ] Menu + cut-off for lunch  
- [ ] Test order → pay → Status → deliver → EOD / Mark paid  
- [ ] Pickup only if pin ready + flag on  

---

## 10. Observability & smoke

| Check | Command / place |
|-------|-----------------|
| API up | `curl $API_URL/health` |
| Staging smoke | `SMOKE_API_URL=$API_URL node scripts/smoke-staging.mjs` |
| WA smoke | `node scripts/smoke-whatsapp.mjs` |
| Trace one order | Cloud Logging: `jsonPayload.traceId="trc_…"` (preferred) or `publicId` — [OBSERVABILITY.md](./OBSERVABILITY.md) |
| OTel (optional) | `OTEL_ENABLED=true` + OTLP endpoint on API + worker |
| Alerts | 5xx, Scheduler, webhook.signature_failed, outbox.failed, whatsapp.send_failed, payment.confirming_stuck, settlement.batch_failed |

---

## 11. Security ops

- Never set `MOCK_*=true` or default `AUTH_SECRET` in production (boot will refuse).  
- `AUTH_ENFORCE` must not be `false` in prod.  
- Rotate `INTERNAL_JOB_TOKEN`, WA token, Razorpay webhook secret via SM.  
- PCI: no card fields on LocalMeals — [SECURITY.md](./SECURITY.md).  
- DAST notes: [DAST.md](./DAST.md).  
- Payment **defensive** checks (not a hack kit): with API up, `python3 scripts/payment_security_probe.py`  
  For HMAC-hard assert set `MOCK_PAYMENTS=false`. In-process: `apps/api/src/security.test.ts`.  
  Broader scan: `npm run security:zap` (local/CI only — never aim at prod).

---

## 12. Escalation order

1. Feature flag / Admin Mark paid / pause cook  
2. Manual Scheduler curl  
3. Cloud Run previous revision  
4. Razorpay / Meta dashboard status  
5. Code fix + forward migration  

Open product/eng backlog: [PENDING.md](./PENDING.md).

---

## 13. Database restore (PITR)

Cloud SQL keeps 14 daily backups and 7 days of transaction logs (`infra/terraform/sql.tf`). **Always restore into a new instance** — never overwrite production in place — then switch over.

1. Pause ordering: Admin → Features → `ordering_enabled` off.
2. Pick the timestamp just **before** the bad event (UTC, from logs/audit):
   ```bash
   gcloud sql instances clone localmeals-pg localmeals-pg-restore \
     --point-in-time='2026-11-23T05:59:00Z'
   # or from a daily backup:
   gcloud sql backups list --instance=localmeals-pg
   gcloud sql backups restore <BACKUP_ID> --restore-instance=localmeals-pg-restore --backup-instance=localmeals-pg
   ```
3. Verify via `cloud-sql-proxy` on the restore instance: row counts in `orders`, `payments`, `refunds`, latest `created_at`.
4. Switch over: update the `DATABASE_URL` secret's host to `/cloudsql/<project>:asia-south1:localmeals-pg-restore`, add that instance to API/worker/migrate (`--add-cloudsql-instances`), redeploy, smoke, re-enable ordering.
5. Reconcile payments captured **after** the restore point from the Razorpay dashboard (webhook redelivery or Admin → Mark paid) — they are not in the restored DB.
6. Import the new instance into Terraform (`terraform import`) or rename back during a maintenance window.

**Drill:** run steps 2–3 against a clone once per quarter and record the time taken (target RTO < 1 h, RPO < 5 min with PITR).
