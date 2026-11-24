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
- PII retention purge: `POST /internal/ops/retention` (worker daily 03:00 IST; `PII_RETENTION_DAYS` default **180** — see [DATA_RETENTION.md](./DATA_RETENTION.md))
- Security headers on Next; CSP with per-request **nonce** (prod: no script `unsafe-inline` / `unsafe-eval`; local Next Fast Refresh still allows `unsafe-eval`)
- `assertAuthed` **always** requires role (admin/internal never soft-open when `AUTH_ENFORCE` is off)
- HTTP `POST /orders` (+ batch / late-request) always require CUSTOMER session; body `customerMobile` cannot spoof another account
- WhatsApp cancel / week Pay check sender owns the order/checkout
- COOK sessions re-checked against LIVE + active kitchen on each request
- `/internal/cutoffs` as COOK only runs for that cook’s kitchen (no global/force)
- Anonymous `GET /orders/:id` and `GET /checkouts/:id` return a **redacted** view (no mobiles); owner/staff get PII
- Stronger `LM-` / `CHK-` ids (`randomBytes`); cook `late-accept` by `publicId` bound to kitchen slug
- `mock-confirm` refuses non-`mock_` ids and is blocked in `NODE_ENV=production`
- CI: `npm run security:check` (static footguns) + `npm run security:audit` (**blocking** high/critical gate with expiring allowlist)
- Free DAST: OWASP ZAP baseline + OpenAPI scan — `npm run security:zap` / workflow `.github/workflows/zap.yml` (see [`DAST.md`](./DAST.md))
- Payment **defensive** probe (rejects forged webhook / mock-confirm abuse / anon admin pay): `python3 scripts/payment_security_probe.py` with API up — not a pen-test
- In-process payment regressions: `apps/api/src/security.test.ts`

### OWASP review fixes (Nov 23, 2026)

| Finding | Fix |
|---|---|
| **F1 Critical** — Terraform plan `infra/terraform/tfplan-solo-cost` (full state incl. `AUTH_SECRET`, `INTERNAL_JOB_TOKEN`, DB password, `ADMIN_MOBILES`) was committed to the **public** repo | File untracked; `tfplan*` / `*.tfplan` / `*.plan` gitignored. **Ops still required:** rotate `AUTH_SECRET`, `INTERNAL_JOB_TOKEN` (+ Scheduler headers), Cloud SQL password / `DATABASE_URL`; purge the file from git history; enable GitHub secret scanning + push protection; keep state in the GCS backend |
| **F2 High** — mock auth on a public `NODE_ENV=production` staging service could mint admin sessions | On any production service: the demo code never works for `ADMIN`, admin codes are random and never echoed as `mockCode`, there is no fallback admin number, and `ADMIN_MOBILES` is required at boot. `deploy.yml` mock fallbacks are now `false`. *Staging admins now sign in with a real WhatsApp OTP* |
| **F3 Medium** — open redirect after login (`?next=/\evil.com`) | `sameOriginPath()` resolves `next` and requires the same origin (`apps/web/src/lib/safeRedirect.ts`) |
| F4 — `npm audit` advisory only | Blocking gate `npm run security:audit` (`scripts/audit-gate.mjs`); reviewed, **expiring** exceptions in `security/audit-allowlist.json` (each with reachability reason) |
| F5 — containers ran as root | `USER node` in api/worker/web images; only uploads / `.next` writable |
| F6 — Cloud SQL accepted unencrypted connections | `ssl_mode = "ENCRYPTED_ONLY"`. Private IP (`ipv4_enabled = false`) is the next planned infra step |
| F7 — rate limits keyed on the proxy IP | Signed-in callers keyed by a session-token hash; `TRUST_PROXY` env (off by default) once the Cloud Run hop chain is verified |
| F8 — OTP request revealed admin / cook numbers | Same 200 response for ineligible numbers (throttled, no code stored or sent) |
| F9 — session token in the login JSON body | Production returns the HttpOnly cookie only (body token kept in dev/tests for Bearer tooling) |

## OWASP API Security Top 10 (2023)

*Current official OWASP API list (no newer edition as of 2026). Status after hardening pass.*

| # | Risk | Status | Notes |
|---|------|--------|--------|
| API1 | Broken Object Level Authorization | **Hardened** | Redacted public order/checkout views; shared `orderOwnership` for HTTP + WA cancel/pay; concern photo bound to order owner; cook cutoffs scoped to own kitchen. |
| API2 | Broken Authentication | **Hardened** | OTP hash, revoke, LIVE cook revalidated on every request; `assertAuthed` fail-closed; HTTP order create **always** requires CUSTOMER session (`bindCustomerMobile` ignores body mobile). |
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
| Deploy | Prefer image digests. Terraform state and plan files contain plaintext secrets — keep them in the GCS state bucket, never in git (`tfplan*` is gitignored) |
| Logs | Avoid logging full OTP codes, PANs (none expected), or raw webhook bodies with PII in durable sinks |

## Ops checklist

- [x] `AUTH_ENFORCE=true` (or unset in `NODE_ENV=production`), strong `AUTH_SECRET`, `MOCK_*=false` *(enforced by `assertProductionConfig` when `NODE_ENV=production`)*
- [x] `WEB_ORIGIN` + `INTERNAL_JOB_TOKEN` set; API refuses to boot without them in production
- [x] Secrets only in Secret Manager *(process; sync script)*
- [ ] Public webhook URLs with matching secrets *(deploy-time)*
- [ ] Cloud Scheduler: cut-off, EOD, and optional retention (`/internal/ops/retention`) *(deploy-time)*
- [ ] Complete SAQ A (or successor) when taking live card volume *(business)*
- [ ] Paid pen-test before wide launch *(business; free ZAP DAST is not a substitute)*
- [ ] Confirm `PII_RETENTION_DAYS` ≥ 180 (or redaction-only) matches legal / Razorpay dispute needs *(business/legal)* — [DATA_RETENTION.md](./DATA_RETENTION.md)

See also `docs/TECHNICAL_DESIGN.md` §14, `docs/ARCHITECTURE.md`, and `docs/MVP1_LAUNCH.md`.

## API contract (OpenAPI / 42Crunch)

- `apps/api/openapi.json` is generated from per-plugin zod contracts (`apps/api/src/plugins/*.contract.ts`), the same schemas the handlers parse with — **116 operations**, every route documented.
- `apps/api/src/openapi/openapi.test.ts` (CI) enforces: offline 42Crunch-style audit (bounded strings/numbers/arrays, `additionalProperties: false`, security schemes, 401/403/429 responses, no credentials in query strings unless an operation records `x-credential-query-justification` — only Meta's `hub.verify_token` handshake), no route drift, and a fresh committed spec.
- Real 42Crunch audit: `.github/workflows/security.yml` job `api-audit` (Ford thresholds 80 overall / 30 security, `42c-conf.yaml`) runs when the `API_TOKEN_42C` secret is set (us.42crunch.cloud).
- ZAP API scan now targets the generated `apps/api/openapi.json` (the hand-written `.zap/openapi.yaml` was removed).

## Production-readiness controls (Nov 24, 2026)

- Graceful `SIGTERM` handling and exit-on-`uncaughtException` (`@localmeals/observability` `installProcessLifecycle`).
- DPDP erasure: `POST /me/account/delete` (refused while orders are in progress, credit remains, or the number runs a kitchen); retained orders are anonymised.
- Account credit ledger is append-only with idempotency keys; per-customer advisory lock prevents concurrent double-spend.
- Public menu-photo bucket holds menu images only; customer concern photos stay in the private bucket behind the API.

