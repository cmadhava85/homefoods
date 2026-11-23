# MVP-1 launch remaining work

Code paths for production channels are in place (`getPaymentProvider` / `getWhatsAppProvider`). Secrets are in Secret Manager and synced to local `.env`.

## Live staging (Cloud Run)

| Service | URL |
|---------|-----|
| API | `https://localmeals-api-o2ryh2iw2a-el.a.run.app` |
| Web | `https://localmeals-web-o2ryh2iw2a-el.a.run.app` |
| Worker | internal (`localmeals-worker`, min instances 1) |

Env on API/worker: `MOCK_PAYMENTS=false`, `MOCK_WHATSAPP=false`, `MOCK_AUTH=false`, `AUTH_ENFORCE=true`.  
Scheduler: `localmeals-lunch-cutoff` (08:00 IST) · `localmeals-eod` (18:00 IST).

**Webhook URLs to paste (if not already):**
- Razorpay → `https://localmeals-api-o2ryh2iw2a-el.a.run.app/webhooks/payments`
- Meta WhatsApp → `https://localmeals-api-o2ryh2iw2a-el.a.run.app/webhooks/whatsapp` (verify token = `WHATSAPP_VERIFY_TOKEN` secret)

**Note:** Local Docker Postgres often binds `:5432`. When migrating Cloud SQL, run Auth Proxy on another port (e.g. `5433`) so migrations do not hit the laptop DB.

## Done in repo

| Item | Where |
|------|--------|
| Razorpay Payment Links + webhook HMAC | `packages/adapters/src/payments.ts` |
| Raw JSON body for HMAC | `apps/api` content-type parser |
| Meta Cloud API send (text + reply buttons) | `packages/adapters/src/whatsapp.ts` |
| Meta inbound signature + button taps | WA webhook in `apps/api` |
| `INTERNAL_JOB_TOKEN` for cut-off / EOD | `X-Internal-Token` or cook/admin session |
| Mock pay confirm disabled when live payments | `POST /payments/mock-confirm` |
| Leaner customer WA (no cooking/packed pings) | `apps/worker` |

## Staging flip checklist

1. **Secrets** (Secret Manager / Cloud Run):
   - `INTERNAL_JOB_TOKEN` (long random)
   - `AUTH_SECRET`, `ADMIN_MOBILES`, `AUTH_ENFORCE=true`
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
   - `WHATSAPP_*` (verify token, app secret, access token, phone number id)
2. **Env:** `MOCK_PAYMENTS=false`, `MOCK_WHATSAPP=false`, `MOCK_AUTH=false`, `NODE_ENV=production`
3. **Razorpay Dashboard**
   - Webhook → `https://API/webhooks/payments` (one endpoint covers all money events)
   - Subscribe (recommended):
     - Pay: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `payment.authorized`, `payment.captured`, `payment.failed`
     - Refunds: `refund.created`, `refund.processed`, `refund.failed`
     - Cook Route: `transfer.processed`, `transfer.failed`, `product.route.activated`, `product.route.under_review`, `product.route.needs_clarification`
     - Payouts / settle: `payout.processed`, `payout.updated`, `payout.failed`, `payout.reversed`, `settlement.processed`
4. **Meta WABA** (see WhatsApp section below)
   - Webhook → `https://API/webhooks/whatsapp` + verify token
   - Submit utility templates: pay link, cook manifest, refund (for outside 24h window)
5. **Cloud Scheduler** (Asia/Kolkata)
   - `POST /internal/cutoffs/LUNCH` with header `X-Internal-Token: …`
   - `POST /internal/settlements/eod` at 18:00 IST with same header
   - Optional: `POST /internal/ops/retention` daily (worker also runs purge at 03:00 when `ENABLE_AUTO_RETENTION` ≠ false)
6. **First LIVE cook**
   - FSSAI number + payout UPI (or bank note); Route `acc_…` optional while RBI-blocked
   - `onboardingStatus=LIVE`, active
7. **Route / RBI turnover**
   - Admin → **Analytics**: week / month / year food GMV + fees per cook; CSV export
   - API: `GET /admin/analytics/turnover?period=month`
8. Smoke: order → pay (real UPI test) → Status on cook WA → cut-off → deliver → EOD

## Razorpay code paths (test/live)

| Flow | Behavior when `MOCK_PAYMENTS=false` |
|------|-------------------------------------|
| Checkout | Creates Razorpay **Payment Link**; stores `plink_…` on order |
| Webhook pay | `payment_link.paid` / `payment.captured` → order `PAID` (+ stores `pay_…`) |
| Admin refund | Calls `POST /payments/{pay_id}/refund` |
| EOD | Route **transfer** to cook `payout_beneficiary_ref` (`acc_…`) |
| Webhook transfer/payout | Updates settlement status + cook ledger |

**Status today:** `RAZORPAY_*` are live in Secret Manager + `.env` (test keys; API auth smoke OK). Local stays on `MOCK_PAYMENTS=true` until payment webhook URL is public. Sync: `npm run secrets:sync`.

Terraform: set `mock_payments = false` and `web_origin = "https://your-web"` when flipping Cloud Run. Secrets must already exist in Secret Manager (`RAZORPAY_*`).

### Flip test mode on Cloud Run (after secrets are set)

```bash
gcloud run services update localmeals-api \
  --region=asia-south1 \
  --update-env-vars=MOCK_PAYMENTS=false,WEB_ORIGIN=https://YOUR_WEB \
  --set-secrets=RAZORPAY_KEY_ID=RAZORPAY_KEY_ID:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest
```

Smoke: place order → open Payment Link → pay with Razorpay test UPI → order becomes `PAID` (webhook). `/payments/mock-confirm` should return 403.

## WhatsApp (Meta Cloud API) setup

**Status today:** Secret Manager + local `.env` have real `WHATSAPP_*` (verify token was rotated off `REPLACE_ME`). Local stays on `MOCK_WHATSAPP=true` (`/wa` simulator) until Meta webhook URL is live. Sync anytime with `./scripts/sync-secrets-from-sm.sh`. Smoke: `node scripts/smoke-whatsapp.mjs` (4/4 Graph + HMAC).

### 1. Meta Business (one-time)

1. [business.facebook.com](https://business.facebook.com) → create/verify Business  
2. Add **WhatsApp accounts** → create WABA  
3. [developers.facebook.com](https://developers.facebook.com) → App → add **WhatsApp** product  
4. **API Setup**:
   - Temporary (or System User permanent) **Access token** → `WHATSAPP_ACCESS_TOKEN`
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
5. App **Settings → Basic → App secret** → `WHATSAPP_APP_SECRET`
6. Choose verify string → `WHATSAPP_VERIFY_TOKEN`  
   ```bash
   openssl rand -hex 16
   ```

### 2. Store secrets

```bash
# Local .env (gitignored)
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_APP_SECRET=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_API_VERSION=v21.0
MOCK_WHATSAPP=true   # keep true until webhook URL works

# Secret Manager
echo -n '...' | gcloud secrets versions add WHATSAPP_VERIFY_TOKEN --data-file=-
echo -n '...' | gcloud secrets versions add WHATSAPP_APP_SECRET --data-file=-
echo -n '...' | gcloud secrets versions add WHATSAPP_ACCESS_TOKEN --data-file=-
echo -n '...' | gcloud secrets versions add WHATSAPP_PHONE_NUMBER_ID --data-file=-
```

### 3. Webhook (needs public HTTPS)

- Callback: `https://YOUR_API/webhooks/whatsapp`
- Verify token: same as `WHATSAPP_VERIFY_TOKEN`
- Subscribe: `messages`  
Local: `ngrok http 4000` then paste the ngrok HTTPS URL.

### 4. Smoke

```bash
npm run build -w @localmeals/adapters
node scripts/smoke-whatsapp.mjs
# optional outbound (must be an allowed test number on the WABA):
WHATSAPP_SMOKE_TO=91XXXXXXXXXX node scripts/smoke-whatsapp.mjs
```

### 5. Templates (outside 24h window)

Submit in Meta → WhatsApp → Message templates (utility):

| Name | Body idea |
|------|-----------|
| `localmeals_login_otp` | LocalMeals login code: {{1}}. Valid 10 minutes. Do not share. |
| `lunch_pay_link` | Order {{1}} — pay: {{2}} |
| `cook_manifest` | {{1}} plates locked · route {{2}} |
| `order_refunded` | Refund for {{1}}: {{2}} |

Adapter supports `send({ template: { name, bodyParams } })` for these once approved. Set `WHATSAPP_OTP_TEMPLATE_NAME=localmeals_login_otp` on the API after approval — free-form OTP often never arrives outside the 24h chat window (while `hello_world` still does).

### 6. Flip staging

```bash
gcloud run services update localmeals-api \
  --region=asia-south1 \
  --update-env-vars=MOCK_WHATSAPP=false \
  --set-secrets=WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,WHATSAPP_APP_SECRET=WHATSAPP_APP_SECRET:latest,WHATSAPP_ACCESS_TOKEN=WHATSAPP_ACCESS_TOKEN:latest,WHATSAPP_PHONE_NUMBER_ID=WHATSAPP_PHONE_NUMBER_ID:latest
```

Same for worker. Keep laptop on mock until Meta is verified.

## Still human / ops (not code)

- Meta WABA + template approvals  
- Razorpay Route linked accounts for each cook (`payout_beneficiary_ref`)  
- Build/push images → set `create_cloud_run=true` in Terraform (api/worker/web + Scheduler + optional alerts) — see [infra/terraform/README.md](../infra/terraform/README.md)  
- Monitoring: set `alert_email` in `terraform.tfvars` then apply  

## Explicitly out of MVP-1

Shadowfax / IVR / public ratings·reviews / multi-day discount engine → MVP-2+.  
Product rules: [PRODUCT_DECISIONS.md](./PRODUCT_DECISIONS.md).
