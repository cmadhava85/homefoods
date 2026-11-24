# Code & Business-Rule Review

> Snapshot review of LocalMeals (Nov 2026). Complements [ARCHITECTURE.md](./ARCHITECTURE.md) and [ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md).
> Severity: 🔴 Critical (money or correctness) · 🟠 High · 🟡 Medium · 🔵 Low (tooling)
>
> **Status legend:** ✅ fixed in code · 🟡 partial / remaining · ⬜ open

## Verdict

All critical and high findings are fixed in code and covered by tests, including the regressions found in the re-review (R1–R14). Remaining work: larger data-model migrations (surrogate user id, DB CHECKs), ESLint/tooling, registering Meta templates, deferred UX items (U8/U9), and the open product questions below.

## 🔁 Fix round 2 — verified (Nov 23, 2026, 18:00 IST)

> **Test run (fresh Postgres, migrated + seeded, root `npm test`, exit 0):** domain 74/74 · adapters 44/44 · i18n 4/4 · observability 6/6 · **API 185/185** · worker 1/1 · web 26/26. **Type-check: 0 errors in every workspace** (API was 23 at the start). Root `npm run typecheck` now covers api, worker and web and runs in CI.
> New suites: `apps/api/src/moneyConcurrency.test.ts` (15 cases, money/concurrency) and `apps/worker/src/drainOutbox.test.ts` (outbox lease; worker added to root `npm test`). **Mutation-checked:** re-introducing the original bug makes the matching test fail for R2, R3, R7, R9 and R11.

| # | Finding (from re-review) | Fix | Test |
|---|---|---|---|
| R1 | Razorpay rejects `expire_by` < 15 min ahead; hold shorter than link | Link TTL 20 min, clamped to ≥ 16 min ahead (`paymentLinkExpireBy`); unpaid hold = link + 5 min (25 min). Customer copy now says 20 min | adapters: expire_by sent; API: hold outlives link |
| R2 | Cut-off ticks re-sent "🔒 locked" every 15 min | `runMealCutoff` notifies only on first lock, newly locked paid orders, or `force` | API R2 (1 message across 3 ticks; force re-sends) |
| R3 | Outbox claim released at commit → duplicate sends | `outbox.locked_until` lease (migration `0031`), claim filters expired leases; in-process in-flight guard; worker jobs fire once per slot | worker lease test (fails on old claim) |
| R4 | `wamid` recorded before processing → messages lost on error | `processWaInboundOnce` releases the dedupe row if the handler throws, so Meta's redelivery is processed | API R4 |
| R5 | `enterWith` actor never reached the handler | `onRequest` hook uses `als.run()` (`http/requestActor.ts`); preHandler fills the actor | API R5 (audit row has admin mobile) |
| R6 | Failed `createPayment` left an orphan hold with no link | Rows released (`CANCELLED`, key cleared, ledger `PAYMENT_LINK_CREATE_FAILED`); returns 502 with a retry message. Late-approve attach is status-guarded | API R6 (retry succeeds) |
| R7 | Concurrent EOD double-counted / aborted; append lost the first transfer id | Upsert settlement row + row lock; orders claimed with `settlementId IS NULL`; totals incremented in SQL by the claimed amount; first `gatewayBatchId` kept | API R7 (3 parallel runs + later append) |
| R8 | Stale `PENDING` refund never reconciled | `PENDING` claims older than 10 min are re-claimed; gateway "already refunded" finalizes instead of failing | API R8 (stale finalized, fresh not double-sent) |
| R9 | Paid-after-terminal refunded/notified per webhook; mixed checkout not refunded; refunded order re-refunded on duplicate capture | Idempotent claim row (`term_<hash of line ids>`) before the gateway call; only cancelled lines refunded; `REFUNDED` treated as already-paid; single-day cancel keeps a shared week link payable | API R9 ×3 |
| R10 | FAILED→PAID over capacity threw → endless webhook retries | Savepoint + cancel the line, ledger `PAID_OVER_CAPACITY`, refunded via R9 path | API R10 |
| R11 | Rebalance counted lines, used current %, ran outside the refund txn, only on one path | Domain `weekDiscountSurvivesCancel` (calendar days); % from order snapshot; runs inside `refundOrder`'s claim txn on first claim only; customer cancel, cook-accept and checkout cancel. Discount is *moved* (not copied), so the total refunded always equals the total paid | domain unit + API R11 (4 lines / 3 days) |
| R12 | Decline could resurrect a refunded order | Row lock + status guard; refuses while a refund claim is pending/done | API R12 (concurrent accept/decline consistent) |
| R13 | OTP compared before reserving an attempt | Atomic reserve (`attempts < 5 AND not expired`) first, then compare; single-use delete-by-hash | API R13 |
| R14 | 409 contract / message | Duplicate key → 409 with localized `error.conflict` (EN/TA); DB text never shown (it was already masked) | `httpErrors.test.ts` |
| UX-W4 | Guard blocked "Save …" and the bot's own Menu buttons; "Cancel order" didn't clear | Address + ordering intents are session-safe; guard only for `PICK_ITEM`/`PICK_ADDRESS`; guard buttons handled first | API UX-W4 + WA e2e journey |
| WA ids | `Cancel/Pay/Delivered/Accept/Review LM-<hex>` never matched (pre-existing) | All five parsers accept hex ids | adapters unit + stricter WA e2e cancel assertion |
| Minor | `ADMIN_MOBILES` checked late; duplicate worker jobs | Required at boot when `MOCK_AUTH=false`; worker expiry behind `ENABLE_AUTO_EXPIRE` (Terraform sets `false` with Scheduler) | `prodConfig.test.ts` |

**Known limits (by design, documented in code):**
- Cancelling an *unpaid* week-cart day does not re-price the remaining days, because the shared link amount is fixed. The cancelled day is refunded automatically if the link is paid anyway (R9).
- The week-discount `minDays` is read from the cook profile; the % comes from the order snapshot.
- Admin/quality refunds do not rebalance the week cart.

## 🔴 Critical — ✅ addressed

| # | Issue | Status |
|---|---|---|
| C1 | Paid after cancel / hold expiry | ✅ `expire_by` (≥ Razorpay min), link cancel, idempotent auto-refund (R1, R6, R9) |
| C2 | Dinner / late never settled | ✅ catch-up + concurrency-safe append; EOD 21:00 IST (R7) |
| C3 | Cut-off vs cancel-request | ✅ `COOKING ↔ CANCEL_REQUESTED`; idempotent all-meal ticks (R2) |
| C4 | Refund races | ✅ lock + claim + stale re-claim + outbox notify (R8) |
| C5 | Duplicate OrderPaid | ✅ conditional update + outbox lease (R3) |

## 🟠 High

| # | Issue | Status | Notes |
|---|---|---|---|
| H1 | Razorpay inside cook-lock txn | ✅ | Reserve/insert → createPayment → attach |
| H2 | Idempotency unique → 500 | ✅ | Catch unique → replay; HTTP 409 not 500 |
| H3 | Webhook handlers without txn | ✅ | |
| H4 | Week-discount / ₹7 fee cancel loophole | ✅ | Rebalance fee + strip discount below minDays |
| H5 | HTTP status via regex | ✅ | `DomainError` + `statusCode`; duplicate→409 |
| H6 | WhatsApp wamid dedupe | ✅ | `wa_inbound_dedupe` + async ack (live) |
| H7 | Side effects on GET | ✅ | Expiry on `/internal/ops/expire-unpaid` (worker 5m) |

## 🟡 Security and auth

- Staging may still enable `MOCK_AUTH` / `MOCK_WHATSAPP` when `APP_ENV=staging` — 🟡 intentional for Meta test numbers; lock down with IAP/IP in ops.
- OTP attempt counter — ✅ atomic
- `requestOtp` throttle before junk user insert — ✅; customer row created on verify
- OTP request throttle in Postgres — ✅ `rate_limit_buckets`
- Default admin mobile — ✅ only when `MOCK_AUTH`; require `ADMIN_MOBILES` otherwise
- Admin session revalidated vs allowlist — ✅
- Admin audit actor — ✅ session mobile via `AsyncLocalStorage`

## 🟡 Domain and data model

- `dayOfWeekForServiceDate` — ✅ TZ-independent
- `FAILED → PAID` capacity re-check — ✅
- Mobile as PK / DB CHECKs / duplicate idempotency index / free-text payment status — ⬜ larger migrations
- `defaultMealSchedule` reads `process.env` — ⬜ low risk under Docker `TZ`
- Line-total helper — ✅ `lineTotalPaise` / `lineFoodNetPaise` in `@localmeals/domain`; every server-side copy (refunds, settlement, clawback, webhook fallback, confirm-return, reports) uses it. Web pages still compute display totals locally.

## ❓ Product decisions (unchanged)

1. Platform keeps SELF delivery fee?
2. Shared `maxDailyCapacity` across meals?
3. `FOOD_ONLY` is terminal `REFUNDED`
4. Cook cancel PAID before cut-off → full refund

## 🔵 Tooling — 🟡

✅ Root `npm run typecheck` covers all 8 workspaces with 0 errors, enforced in CI (`.github/workflows/ci.yml`): `tx`-vs-`Db` helpers use a new `DbOrTx` type, and the rate-limit store and menu-template input types were fixed. ⬜ ESLint (`import/no-cycle`, `no-floating-promises`) is still open. Concurrency tests now exist (`moneyConcurrency.test.ts`, worker lease test); fake-clock tests for cut-off timing are still open.

## ✅ Strengths

Integer paise, IST via `Intl`, explicit state machine, capacity locks, order snapshots, transactional outbox (claimed), HMAC webhooks.

## 🛡️ Security review — OWASP (Nov 23, 2026)

OWASP Top 10 / API Top 10 (2023) / ASVS L2 review: 9 findings (1 critical, 1 high, 1 medium, 6 low). All code and config fixes are in, with regression tests in `apps/api/src/security.test.ts`. Details and the remaining ops steps are in [SECURITY.md](./SECURITY.md#owasp-review-fixes-nov-23-2026).

> 🔴 **Action required outside code:** the committed Terraform plan exposed production secrets in a public repo. Rotate `AUTH_SECRET`, `INTERNAL_JOB_TOKEN` and the DB password, and purge the file from git history.

## 🎨 UI/UX review (Nov 23, 2026)

> Code-based review of `apps/web` and the WhatsApp bot (`apps/api/src/wa`, `packages/i18n`, `apps/worker`), not a live-device test. Counts were verified with grep. Severity: 🔴 High · 🟠 Med · 🟡 Low.

**Verdict:** High/med UX gaps from this review are addressed in code (templates behind env, STOP/START, synonyms + reorder, allergens, focus, price breakdown, locale cookie, family/late copy). Remaining: register Meta templates + set `WHATSAPP_TMPL_*`; deferred U8/U9 (page splits / `next/image`).

### WhatsApp bot

| # | Sev | Status | Issue |
|---|---|---|---|
| UX-W1 | 🔴 | ✅ | Templates when `WHATSAPP_TMPL_ORDER_PAID` / `_ORDER_STATUS` / `_REFUND` / `_MENU_ALERT` env set (else free-form fallback) |
| UX-W2 | 🔴 | ✅ | STOP / START ALERTS → `consents.waMarketingOptOut`; menu alerts skipped |
| UX-W3 | 🔴 | ✅ | Normalize + Tanglish synonyms; REORDER (“again” / “same as yesterday”) |
| UX-W4 | 🟠 | ✅ | Mid-checkout guard (cart with items only): Continue / Cancel order; address + Menu/Order steps pass through (fixed in round 2) |
| UX-W5 | 🟠 | ✅ | Food · delivery · platform · total before pay (single + week) |
| UX-W6 | 🟠 | ✅ | Family / review / late / opt-out / price strings in i18n EN+TA |
| UX-W7 | 🟡 | ✅ | Short buttons (`Pay`, `Whole week`, `Menu`) |
| UX-W8 | 🟡 | ✅ | Family-pay copy plain-language |

**Ordering takes about 4 replies from "hi"** (kitchen → dish → address → pay). A "Same as yesterday" button, using the saved address and last kitchen, could bring repeat customers down to 1–2 taps, which is the biggest conversion win available.

### Web UI

| # | Sev | Status | Issue |
|---|---|---|---|
| UX-U1 | 🔴 | ✅ | Allergens shown on kitchen plates + WA order confirm |
| UX-U2 | 🔴 | ✅ | Global `:focus-visible` ring |
| UX-U3 | 🔴 | ✅ | Late note includes ~15–30 min confirm ETA |
| UX-U4 | 🟠 | ✅ | Pay page always shows delivery + platform (+ discount) |
| UX-U5 | 🟠 | ✅ | Empty/error pay state separated; Retry + Orders |
| UX-U6 | 🟠 | ✅ | Persistent labels + `aria-describedby` on address fields |
| UX-U7 | 🟠 | ✅ | `lang` from `lm_locale` cookie on the server |
| UX-U8 | 🟡 | ⬜ | Large page splits / fewer inline styles (deferred) |
| UX-U9 | 🟡 | ⬜ | `next/image` migration (deferred) |
| UX-U10 | 🟡 | ✅ | `formatInr` / `formatInrAmount` helper; pay page uses it |

### What's done well

- **Trust signals:** FSSAI licence, ratings, veg/non-veg marker, spice level and delivery window are all visible.
- **Clear local discovery:** customers find kitchens by PIN code, with a helpful "no kitchens nearby" state.
- **Order flows:** the week cart, pickup vs delivery, and the cancel vs request-cancel split are thoughtful, and the cancel options come from the server.
- **Order tracking:** the confirmation page shows progress, and there's a reorder button.
- **Tamil support:** a Tamil font and Tamil/English message files, numbered replies on WhatsApp, and the adapter enforces Meta's 3-button / 20-character limits.

### Top remaining UX priorities

1. Register Meta utility templates and set `WHATSAPP_TMPL_ORDER_PAID` / `_ORDER_STATUS` / `_REFUND` / `_MENU_ALERT` in prod.
2. UX-U8 — split cook desk / admin / `KitchenBrowse` and reduce inline styles.
3. UX-U9 — `next/image` for remote kitchen photos.

## 🚀 Production readiness + cost round (Nov 24, 2026)

Verified on a fresh database: **447 tests pass** (domain 77, adapters 48, observability 11, i18n 4, API 240, worker 34, web 33); every coverage gate met (API 81 % lines / 67 % branches / 76 % functions). Root typecheck clean.

| Area | Change | Tests |
|------|--------|-------|
| OpenAPI / 42Crunch | All 116 routes have zod contracts shared with the handlers (bounded inputs); generated `openapi.json`; audit/drift/freshness gate; 42Crunch CI job (Ford 80/30) when `API_TOKEN_42C` is set; ZAP scans the generated spec | `openapi.test.ts` (4) |
| Lifecycle | SIGTERM drains HTTP / outbox, closes DB, flushes traces (8 s cap); `uncaughtException` exits 1; web container execs node | `lifecycle.test.ts` (5) |
| Deploy | Migrations as Cloud Run Job before any revision; API + web deployed `--no-traffic` → smoke → promote; rollback + PITR restore runbook | — |
| DB resilience | PITR (7 d logs), 14 backups, Query Insights, `db_availability_type`, GCS remote state | `terraform validate` |
| Monitoring | Uptime checks + DOWN alerts (api/web), Cloud SQL saturation alert, monthly INR budget | `terraform validate` |
| Web | 404 / error / global-error pages, robots, sitemap, manifest, OG metadata; `/wa` simulator hidden in production | site/legal tests |
| Legal / DPDP | Terms, Privacy, Refunds, Delivery, Contact & Grievance pages (draft banner until business details set); `POST /me/account/delete` + account UI | `accountDeletion.test.ts` (3, mutation-checked) |
| Load test | k6 cut-off rush (`loadtest/`) | ran locally: read p95 21 ms |
| **Bug (found by load test)** | Re-ordering the same plate after cancelling returned 409 — the CHARGE row kept the freed idempotency key; also Razorpay `Idempotency-Key` was truncated to 64 chars (tail collisions) | `LOAD-1` (mutation-checked) + adapter test |
| **Bug (found by slim images)** | API image never installed/built `@localmeals/i18n` — only worked when a local `dist/` leaked into the build context | image boot + smoke |

**Cost features** (details and switches in [COST.md](./COST.md)): scale-to-zero worker (Pub/Sub wake + scheduler fallback), in-memory global rate limit, slim images, log exclusion, public menu-photo bucket, free 24 h WhatsApp window, normal-speed refunds, refund-to-credit wallet (+ credit-paid orders skip Razorpay), convenience fee (flag **off** until legal review), pickup UPI QR (0.99 %), confirm-before-pay. Tests: `feeCreditQr.test.ts` (6, lock + debit mutation-checked), `outboxWake.test.ts` (5), `hybridRateLimitStore.test.ts` (3), worker push/window tests, domain fee/credit tests.

### Owner actions before go-live
1. `terraform init -backend-config=backend.hcl -migrate-state`, then delete local state files (contain the DB password).
2. `terraform apply`, then repo vars `WORKER_PUSH_MODE=true`, `MENU_IMAGES_PUBLIC=true` (after the one-time photo copy in COST.md).
3. Razorpay dashboard: add the `qr_code.credited` webhook event; confirm refunds default to normal speed.
4. Fill `NEXT_PUBLIC_LEGAL_*` / grievance-officer values; legal/CA review of Terms, Privacy, Refunds (incl. convenience-fee wording) before enabling `convenience_fee_enabled`.
5. `API_TOKEN_42C` secret for the hosted 42Crunch audit; set `alert_email`, `billing_account_id`.
6. Still open from earlier: rotate secrets + purge `tfplan-solo-cost` from history; Meta template approval.
