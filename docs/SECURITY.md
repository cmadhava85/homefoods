# Security & PCI scope

## What LocalMeals handles

- **OTP sessions** (HttpOnly `lm_session` via Next `/lm-api` proxy; logout revokes by `iat`)
- **Orders, menus, cook desk, admin ops** — Bearer/cookie auth; kitchen mutators always require COOK/ADMIN
- **Payment orchestration** — create Razorpay Payment Links, verify webhooks (HMAC), mark orders paid
- **PII** — customer mobile, addresses, order history in Postgres

## What LocalMeals must never handle

- Card **PAN**, CVV, full track data, or saved card vaults
- Custom card forms / iframes that capture PAN on LocalMeals domains

Checkout is **Razorpay hosted Payment Links**. Customers leave our UI to pay on Razorpay.

## PCI-DSS posture (not a certification)

| Item | Status |
|------|--------|
| Formal PCI AoC / SAQ filed | **Not done** — business process |
| Card data stored by LocalMeals | **No** (by design) |
| Likely SAQ target if kept outsourced | **SAQ A** (payment page fully outsourced) |
| Razorpay | PCI-certified processor (their AoC) |

**SAQ A only applies if** you never collect card data on LocalMeals web/WA, don’t embed a card-entry iframe you control, and keep Payment Links / Razorpay Checkout as the only card/UPI capture surface.

This document is **scope guidance**, not a PCI attestation.

### SAQ A self-check (before filing)

- [x] No card number / CVV fields exist in LocalMeals web, WhatsApp flows, or admin tools *(code review — Payment Links / redirect only)*
- [x] Checkout always redirects / deep-links to Razorpay Payment Link (or Razorpay-hosted Checkout) *(web pay page + adapters)*
- [x] No iframe embedding a LocalMeals-owned card form
- [x] Webhooks verify HMAC; order totals are server-side; paid amount re-checked when gateway amount is present *(live confirm-return requires amount; mock may omit)*
- [x] Secrets (Razorpay keys, webhook secret) live in Secret Manager — not in git / client bundles *(ops practice + `secrets:sync`; no keys in repo)*
- [x] Production boot refuses default `AUTH_SECRET` and `MOCK_PAYMENTS=true` (`assertProductionConfig`)
- [ ] Retain Razorpay’s current PCI AoC for your merchant account *(business)*
- [ ] Complete SAQ A (or successor questionnaire) with QSA / self-assessment when taking live card volume *(business)*

## Controls in code (MVP)

- Webhook HMAC (Razorpay + Meta WhatsApp)
- Server-side order totals; paid amount re-checked on webhook / confirm-return when gateway amount present
- CORS allow-list (`WEB_ORIGIN` + optional `CORS_ORIGINS`)
- Global + route rate limits via Postgres store (`rate_limit_buckets`); **fail-closed in production** if the store errors
- OTP hashed in DB; request/verify throttles; WhatsApp delivery when `MOCK_AUTH=false`
- Session revoke on logout (`auth_revocations`)
- Upload magic-byte sniff (JPEG/PNG/WebP/GIF); concern `photoUrl` allowlisted to `/uploads/concern-…`
- Production boot checks (`assertProductionConfig`) for secrets + `MOCK_*=false`
- PII retention purge: `POST /internal/ops/retention` (worker daily 03:00; `PII_RETENTION_DAYS` default 90)
- Security headers on Next; CSP with per-request **nonce** (prod: no script `unsafe-inline` / `unsafe-eval`; local Next Fast Refresh still allows `unsafe-eval`)
- `assertAuthed` **always** requires role (admin/internal never soft-open when `AUTH_ENFORCE` is off)
- Anonymous `GET /orders/:id` and `GET /checkouts/:id` return a **redacted** view (no mobiles); owner/staff get PII
- Stronger `LM-` / `CHK-` ids (`randomBytes`); cook `late-accept` by `publicId` bound to kitchen slug
- `mock-confirm` refuses non-`mock_` ids and is blocked in `NODE_ENV=production`
- CI: `npm run security:check` (static footguns) + `npm run security:audit` (advisory)
- Free DAST: OWASP ZAP baseline + OpenAPI scan — `npm run security:zap` / workflow `.github/workflows/zap.yml` (see [`DAST.md`](./DAST.md))
- Payment **defensive** probe (rejects forged webhook / mock-confirm abuse / anon admin pay): `python3 scripts/payment_security_probe.py` with API up — not a pen-test
- In-process payment regressions: `apps/api/src/security.test.ts`

## OWASP API Security Top 10 (2023)

*Current official OWASP API list (no newer edition as of 2026). Status after hardening pass.*

| # | Risk | Status | Notes |
|---|------|--------|--------|
| API1 | Broken Object Level Authorization | **Partial** | Redacted public order/checkout views (no mobiles/address — `hasDeliveryAddress` only); cancel/concern/review ownership; late-accept kitchen bind; hardened `LM-`/`CHK-` ids. |
| API2 | Broken Authentication | **Partial** | OTP hash, revoke, LIVE cook desk, prod boot. `assertAuthed` fail-closed. Soft customer binding when `AUTH_ENFORCE` off remains for local/tests only. |
| API3 | Broken Object Property Level Authorization | **Partial** | Zod writes; public DTO strips mobiles; concern photo allowlist. |
| API4 | Unrestricted Resource Consumption | **Partial** | Global + route limits; Postgres store; prod fail-closed on store errors. |
| API5 | Broken Function Level Authorization | **Partial** | Kitchen staff always enforced; admin via `assertAuthed`; internal token or staff. |
| API6 | Unrestricted Access to Sensitive Business Flows | **Partial** | Live pay path HMAC + amount; mock-confirm gated; order spam still easier when auth soft locally. |
| API7 | SSRF | **Strong** | No user-controlled URL fetch; photo URLs allowlisted. |
| API8 | Security Misconfiguration | **Partial** | CORS allow-list, prod config, CSP nonce. Mocks must stay off in prod (enforced at boot). |
| API9 | Improper Inventory Management | **Partial** | Plugin inventory in ARCHITECTURE.md; mock webhook GET hint hidden in production. |
| API10 | Unsafe Consumption of APIs | **Partial** | Confirm-return binds payment link to order; live amount required. |

**Still open (not code-only):** paid pen-test, formal SAQ filing, continuous threat modeling as routes grow. GCS uploads + local fallback are implemented (`GCS_UPLOADS_BUCKET`). Free ZAP DAST is wired (see [`DAST.md`](./DAST.md)).

## IAM & secrets ops

| Control | Practice |
|---------|----------|
| Secret storage | GCP Secret Manager only; sync locally via `npm run secrets:sync` |
| Runtime identity | Cloud Run service accounts with least privilege (Secret Manager accessor, Cloud SQL client) |
| Job auth | `INTERNAL_JOB_TOKEN` on Scheduler / worker → `X-Internal-Token` |
| Human admin | OTP + `ADMIN_MOBILES`; no shared long-lived API keys in browsers |
| Rotation | Rotate `AUTH_SECRET`, `INTERNAL_JOB_TOKEN`, Razorpay webhook secret, Meta app secret on schedule or after incident |
| Deploy | Prefer image digests; no secrets in Terraform state plaintext beyond Secret Manager refs |
| Logs | Avoid logging full OTP codes, PANs (none expected), or raw webhook bodies with PII in durable sinks |

## Ops checklist

- [x] `AUTH_ENFORCE=true` (or unset in `NODE_ENV=production`), strong `AUTH_SECRET`, `MOCK_*=false` *(enforced by `assertProductionConfig` when `NODE_ENV=production`)*
- [x] `WEB_ORIGIN` + `INTERNAL_JOB_TOKEN` set; API refuses to boot without them in production
- [x] Secrets only in Secret Manager *(process; sync script)*
- [ ] Public webhook URLs with matching secrets *(deploy-time)*
- [ ] Cloud Scheduler: cut-off, EOD, and optional retention (`/internal/ops/retention`) *(deploy-time)*
- [ ] Complete SAQ A (or successor) when taking live card volume *(business)*
- [ ] Paid pen-test before wide launch *(business; free ZAP DAST is not a substitute)*
- [ ] Confirm `PII_RETENTION_DAYS` matches legal / support needs *(business/legal)*

See also `docs/TECHNICAL_DESIGN.md` §14, `docs/ARCHITECTURE.md`, and `docs/MVP1_LAUNCH.md`.
