# Production operational readiness review

**Date:** 2026-11-24 · **Scope:** api / worker / web, Terraform, CI/CD, live GCP project (read-only checks), support workflows  
**Companion:** [RUNBOOK.md](./RUNBOOK.md) · [OBSERVABILITY.md](./OBSERVABILITY.md) · [COST.md](./COST.md) · [PENDING.md](./PENDING.md)

## Verdict

**Not production-ready operationally.** The money paths, order tracing, and backups are well built, but the team would currently learn about outages from customers:

- No alert policies, log-based metrics, notification channels, uptime checks, or dashboards exist in the live project.
- Unhandled server errors are returned as **HTTP 400** with raw internal messages and are not logged with stacks, so outages look like client errors.
- A lunch-window outage on **2026-11-23** (schema drift after a manual deploy) went undetected by tooling.
- Secret material from a historical Terraform plan artifact remains in git history of a public repository.

**Method:** repo, docs, Terraform, and workflow review; read-only `gcloud` (Cloud Run, Monitoring, Scheduler, Cloud SQL, Logging) and `gh` checks. No changes were made to infrastructure.

### Priority scale

| Priority | Meaning |
|----------|---------|
| **P0** | Fix now, before taking real customer money |
| **P1** | Fix before launch |
| **P2** | Next 30–60 days |

---

## Findings

### P0-1 · Secrets in public git history

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | Repo visibility is `PUBLIC`. `infra/terraform/tfplan-solo-cost` was deleted from HEAD but remains in history; the plan archive embeds Terraform state including secret fields. Listed as still open in [CODE_REVIEW.md](./CODE_REVIEW.md) "Owner actions" #6. |
| **Impact** | DB password, `AUTH_SECRET` (session forgery incl. admin), `INTERNAL_JOB_TOKEN` (trigger EOD/cut-off), Razorpay and Meta secrets must be treated as compromised. |
| **Action** | Rotate every Secret Manager secret and the DB password; purge the file from history; request GitHub cache purge; review audit logs for misuse. |

### P0-2 · No alerting exists in production

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | Live project: `gcloud monitoring policies list`, log metrics, channels, uptime checks, dashboards are all empty. Local `terraform.tfvars` has no `alert_email` and `create_cloud_run = false`, which also disables the API 5xx alert, uptime checks, and Scheduler jobs in Terraform ([monitoring.tf](../infra/terraform/monitoring.tf), [monitoring_uptime.tf](../infra/terraform/monitoring_uptime.tf), [scheduler.tf](../infra/terraform/scheduler.tf)). [OBSERVABILITY.md](./OBSERVABILITY.md) and [RUNBOOK.md](./RUNBOOK.md) §10 describe these alerts as present. |
| **Impact** | Last 7 days: 30 `outbox.failed`, 17 API `ERROR` lines, and a lunch-window outage — nobody notified. |
| **Action** | Configure alert channels (email + a paging channel), decouple uptime/5xx alerts from `create_cloud_run`, apply, then test-fire each policy. |

### P0-3 · Server faults become 400s, are not logged, and leak internals

| | |
|---|---|
| **Status** | Confirmed (code + live logs) |
| **Evidence** | [`httpStatusForError`](../apps/api/src/httpErrors.ts) falls through to `return 400`; [`sendCaughtError`](../apps/api/src/httpErrorHandler.ts) (96 call sites) never logs; [`publicErrorMessage`](../apps/api/src/httpErrors.ts) returns raw `err.message`. Live 2026-11-23 06:29–06:48 UTC (~12:00 IST): `/kitchens…`, `/me/orders` returned `400 column "late_orders_enabled" does not exist`. |
| **Impact** | Outages are invisible to 5xx alerts and SLOs; SQL / gateway text is exposed to users; Error Reporting gets no stacks. |
| **Action** | Default unclassified errors to 500; use typed errors for 4xx; log ≥500 with stack; generic message + `requestId` to clients. |

### P1-4 · Manual deploy bypassed migrations (root cause of 23 Nov outage)

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | API revision `localmeals-api-00032` created 2026-11-23 06:01 UTC while all pipeline deploys that day failed — i.e. deployed outside the pipeline, skipping the migrate job and candidate smoke. [PENDING.md](./PENDING.md) still instructs manual migration "after each deploy". |
| **Impact** | Code shipped ahead of schema; core browse/order endpoints broken during lunch. |
| **Action** | Restrict deploy rights to the pipeline SA; fail readiness when DB migrations lag the code; remove manual-migration instructions. |

### P1-5 · Deploy pipeline red and drifting from live config

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | Last 5 `Deploy Cloud Run` runs failed on `next build` type errors (CI only runs `tsc`). Repo vars `MOCK_PAYMENTS/MOCK_AUTH/MOCK_WHATSAPP=true`, `AUTH_ENFORCE=false`; live API has mocks off, `AUTH_ENFORCE=true`, `APP_ENV=staging`. [deploy.yml](../.github/workflows/deploy.yml) uses `--set-env-vars`, which replaces all env vars (drops `APP_ENV`, `LOG_LEVEL`). |
| **Impact** | Next green build deploys an API that [prodConfig.ts](../apps/api/src/prodConfig.ts) refuses to boot — blocks hotfixes. |
| **Action** | Run the real `next build` / Docker build in PR CI; align repo vars with live; single source of truth for runtime env. |

### P1-6 · Health checks are liveness-only

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | API [`/health`](../apps/api/src/plugins/metaRoutes.ts) returns `{ ok: true }` unconditionally; worker health always `ok`. `/health` stayed 200 during the 23 Nov outage. No startup/readiness probe in the deploy. |
| **Action** | Add `/ready` (DB `select 1`, migration version, oldest outbox age); use as startup probe and uptime target; add a synthetic browse uptime check. |

### P1-7 · Outbox / worker blind spots and silent job failures

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | No backlog or oldest-pending-age metric. Max-attempt and flag-off rows are marked processed with no replay ([drainOutbox.ts](../apps/worker/src/drainOutbox.ts)). Worker `expire-unpaid` / `retention` calls ignore HTTP status ([worker index.ts](../apps/worker/src/index.ts)). Worker uses container-local time (UTC): "03:00" retention runs at 08:30 IST. `WORKER_PUSH_MODE=true` would scale the worker to zero though Terraform never created the wake topic / fallback scheduler. Last week's failures were DB disconnects/restarts. |
| **Impact** | Cooks/customers silently miss WhatsApp notifications; maintenance jobs fail silently. |
| **Action** | Backlog/parked alerts, Admin retry, check `res.ok`, explicit `Asia/Kolkata`, guard push mode. |

### P1-8 · No timeouts on Razorpay / Meta calls

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | No timeout/abort on fetches in [payments.ts](../packages/adapters/src/payments.ts) and [whatsapp.ts](../packages/adapters/src/whatsapp.ts) (logistics has one). Non-JSON error bodies throw `SyntaxError` → 400. |
| **Impact** | Provider brownouts hold requests and the small DB pool; gateway outages appear as client errors. |
| **Action** | `AbortSignal.timeout`, bounded retries with existing idempotency keys, map to 502/503, alert on provider error rate. |

### P1-9 · Customer / cook issue reporting and outage communication

| | |
|---|---|
| **Status** | Confirmed (code + live) |
| **Evidence** | Live `/legal/contact` returns **404** (deployed web predates legal pages). [legal.ts](../apps/web/src/lib/legal.ts) falls back to `[support email]` placeholders and neither the web Dockerfile nor deploy workflow passes `NEXT_PUBLIC_LEGAL_*` / `NEXT_PUBLIC_SUPPORT_*`. Tickets only via web concern or WhatsApp "help" — both need the API. No ops notification on new tickets; `slaDueAt` (2 h) set but never shown or alerted. No cook ticket channel found. Web error page shows only the Next digest; API `X-Request-Id` never surfaced to users. No status page. |
| **Impact** | When the app is down customers have no route to support; grievance-officer details required by the Consumer Protection (E-Commerce) Rules are missing; support cannot join a report to logs except via order ID. |
| **Action** | Pass build args; static status/contact page off Cloud Run; WhatsApp Business auto-reply; show request reference on errors; new-ticket alert + SLA breach view; cook issue channel; customer ticket status. |

### P1-10 · Ownership, on-call, escalation, incident process

| | |
|---|---|
| **Status** | Confirmed |
| **Evidence** | [CODEOWNERS](../.github/CODEOWNERS) has a single owner; `main` has no branch protection. [RUNBOOK.md](./RUNBOOK.md) §12 escalation lists technical steps, not people; no severity levels, vendor contacts, comms templates, or postmortem process. No GitHub issues / incident label; the 23 Nov outage has no write-up. |
| **Impact** | Bus factor of 1 during the lunch window; recurring issues are not tracked. |
| **Action** | Named primary + backup, severity matrix, vendor escalation contacts, comms templates, incident log + postmortem template, branch protection. |

### P2-11 · Capacity

**Evidence:** `db-f1-micro` (shared core, no SLA), ZONAL, ~25 connections; API up to 5 instances × pool + worker. Unexplained DB "shutting down / starting up" events on 2026-11-20. k6 test only run locally.  
**Action:** move to ≥ `db-g1-small`; budget `instances × pool ≤ 80 %` of `max_connections`; run [loadtest](../loadtest/README.md) against the cloud environment.

### P2-12 · Auditability

**Good:** refunds, holds, cook approve/pause, payout details, manual pay, tickets, feature flags, account deletion are audited with actor.  
**Gaps:** Admin "Run EOD" not audited; internal-token calls attributed to `"owner"`; `INTERNAL_JOB_TOKEN` stored in plaintext Scheduler headers (prefer OIDC); admin console path published in docs.

### P2-13 · Data retention and privacy

**Gaps:** order activity ledger purged at 90 days (payment disputes can arrive ~120 days later); `support_tickets`, order addresses/mobiles, `admin_action_log` payloads have no retention period; concern photos deleted at 180 days; Cloud Logging `_Default` keeps 30 days; retention job has no success signal.  
**Action:** per-table retention schedule (DPDP), log sink to GCS/BigQuery ≥ 120 days, alert on retention failures.

### P2-14 · Recovery drills and dashboards

**Good:** PITR (7 d), 14 backups, deletion protection; last 3 daily backups `SUCCESSFUL`.  
**Gaps:** no recorded restore drill; no off-project backup copy (relevant given P0-1); no dashboards; OTel off.

---

## Strengths to keep

- Durable `traceId` across API → Razorpay → logistics → outbox → worker; Admin → Orders lookup by `LM-…` / `trc_…` / txn id.
- Stable `event` log markers; masked mobiles; Cloud Logging severity maps correctly (`WARN` → `WARNING`).
- Idempotent, row-locked refunds; HMAC-verified webhooks; production boot guard.
- Candidate → smoke → promote deploys; expand-only migrations policy; feature-flag kill switches.
- Practical runbook incl. PITR restore.

## Could not be verified

- Whether exposed secrets were rotated or misused.
- Razorpay live vs test keys in use; Meta template approval.
- Cloud Audit Logs data-access configuration; IAM membership; who deployed `api-00032`.
- Whether anyone watches Scheduler status manually; vendor support plans.
- Exact customer impact / duration of the 23 Nov outage (log sample capped; last error seen 06:48 UTC).
- Whether a separate production environment exists (today: one project, `APP_ENV=staging`).

---

## Prioritized checklist

- [ ] **P0-1** Rotate all secrets + DB password; purge plan artifact from history; review logs — *script/docs/CI gate in progress; human must rotate + purge*
- [ ] **P0-2** Alert channels + policies + uptime checks applied and test-fired — *TF decoupling in progress; needs `alert_email` + apply*
- [x] **P0-3** Unclassified errors → 500, logged with stack, generic message + `requestId`
- [x] **P1-4** Schema-version boot gate (`assertSchemaCurrent`); pipeline-only still a manual IAM note
- [ ] **P1-5** `next build` in CI; repo vars aligned with live; single env source
- [x] **P1-6** `/ready` on API + worker; deploy startup/liveness probes; uptime TF path `/ready` (needs `terraform apply`); smoke asserts `/ready`
- [x] **P1-7** Outbox backlog / parked logs, Admin retry (+ wake), job `res.ok`, IST clock
- [x] **P1-8** Third-party timeouts + retries (`fetchWithTimeout`); Meta error codes preserved for park
- [ ] **P1-9** Real contact/grievance page, static status page, request refs, ticket alerts + SLA, cook channel
- [ ] **P1-10** On-call + backup, severities, contacts, comms templates, postmortems, branch protection
- [ ] **P2-11** DB tier + connection budget + cloud load test
- [ ] **P2-12** Audit Run EOD; per-caller identity; Scheduler OIDC — *partial: RUN_EOD audit wired*
- [ ] **P2-13** Retention schedule, log sink, retention alerts
- [ ] **P2-14** Restore drill, off-project backup, ops dashboard

## Questions for the team

1. Have secrets been rotated since the plan artifact was committed? Who may have cloned/forked the repo?
2. Who deployed `api-00032` on 23 Nov, and how was the outage noticed and fixed?
3. Is this project staging or production? Is a separate prod project planned?
4. Who is on call for the lunch window and EOD, and who is the backup?
5. What are the real support phone/email and Grievance Officer details?
6. Are DB restarts caused by the cost-sleep scripts or something else?
7. How should cooks raise issues — Admin, WhatsApp, or a new channel?
8. What retention periods do legal and Razorpay require for orders, tickets, and logs?

---

## Fix prompts

Copy-paste prompts for a coding agent (or engineer). Each is self-contained and ends with acceptance criteria. Run them in order; P0 first. Prompts marked **(manual)** need a human with GCP / GitHub admin access.

### Prompt P0-1 — Secret rotation and history purge (manual + scripted)

```text
Context: LocalMeals (repo cmadhava85/homefoods, GCP project home-food-513806). A Terraform plan
artifact `infra/terraform/tfplan-solo-cost` was committed and later deleted; it remains in git
history and contains Terraform state with secret values. Treat all secrets as compromised.

Do:
1. Write `scripts/rotate-secrets.sh` that, for each Secret Manager secret used by Cloud Run
   (DATABASE_URL, INTERNAL_JOB_TOKEN, AUTH_SECRET, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
   WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN), adds a new version from
   stdin/generated value and prints the follow-up vendor step (Razorpay dashboard, Meta, Scheduler).
   Never echo secret values. DB password: rotate via `gcloud sql users set-password` and rebuild
   DATABASE_URL. INTERNAL_JOB_TOKEN: also update the Cloud Scheduler job headers.
2. Add a "Secret rotation" section to docs/RUNBOOK.md §11 describing the order: rotate → update
   vendor dashboards → redeploy api/worker → verify webhooks + scheduler → disable old versions.
3. Document the history purge in docs/RUNBOOK.md (git filter-repo --path
   infra/terraform/tfplan-solo-cost --invert-paths, force-push, ask collaborators to re-clone,
   GitHub support request to purge cached views). Do NOT run the force-push yourself.
4. Ensure infra/terraform/.gitignore ignores tfplan*, *.tfstate*, terraform.tfvars, and add a
   gitleaks rule or path check in .github/workflows/security.yml that fails on tfplan files.

Acceptance: script is idempotent and prints no secrets; docs updated; CI fails if a tfplan file
is committed; checklist item P0-1 in docs/OPS_READINESS.md can be ticked after a human runs it.
```

### Prompt P0-2 — Make alerting real

```text
Context: infra/terraform/monitoring.tf and monitoring_uptime.tf define log metrics, alert policies,
and uptime checks, but they are gated on `alert_email != ""` and (for API 5xx, uptime, scheduler)
on `local.create_api`, which is false because `create_cloud_run = false` (Cloud Run services are
deployed by GitHub Actions, not Terraform). Live project currently has zero policies.

Do:
1. Add variables `api_service_name` (default "localmeals-api"), `web_service_name`,
   `worker_service_name`, and `api_url` / `web_url` (strings). Use them for the 5xx alert filter
   and uptime hosts so monitoring no longer depends on create_cloud_run.
2. Do the same for scheduler.tf: allow scheduler jobs when `api_url` is set even if
   create_cloud_run=false. Keep existing names (localmeals-lunch-cutoff, localmeals-eod) and
   document `terraform import` commands for the jobs that already exist.
3. Add `alert_channels_extra` (list of notification channel ids, e.g. SMS / PagerDuty) appended to
   every policy's notification_channels. Add `documentation { content = ... }` to every policy
   linking the matching RUNBOOK.md section.
4. Add policies: API request latency p95 > 2s for 10m; outbox oldest-pending age (see P1-7 metric);
   absence of `cutoff.reached` after the lunch cut-off window; absence of `settlement.batch_completed`
   within 1h after EOD schedule.
5. Add a `google_monitoring_dashboard` "LocalMeals ops" with: request rate/5xx/latency per service,
   Cloud SQL CPU/connections/disk, outbox failures, webhook signature failures, scheduler attempts.
6. Update terraform.tfvars.example and docs/OBSERVABILITY.md "Alerts" with the new variables and a
   "test-fire" procedure (e.g. emit a fake `payment.confirming_stuck` log via `gcloud logging write`).

Acceptance: `terraform validate` passes; with create_cloud_run=false and alert_email set, `terraform
plan` creates all policies, uptime checks, and the dashboard; docs describe how to test each alert.
```

### Prompt P0-3 — Correct error classification and logging in the API

```text
Context: apps/api/src/httpErrors.ts `httpStatusForError` returns 400 for any unrecognised error;
apps/api/src/httpErrorHandler.ts `sendCaughtError` (used in ~96 route catch blocks) never logs;
`publicErrorMessage` returns raw err.message to clients. In production this turned a schema error
(`column "late_orders_enabled" does not exist`) into a 400 shown to customers, invisible to 5xx alerts.

Do:
1. Introduce a small typed error (e.g. `HttpError` / `DomainError` with `statusCode` and an i18n
   key) in apps/api/src/httpErrors.ts. Keep existing regex mapping for known business messages for
   backward compatibility, but change the fallthrough to 500.
2. In `sendCaughtError` and the global error handler: for status >= 500, log with
   `{ err, event: LogEvent.REQUEST_FAILED, ...triageFromCorr() }` at error level (full stack) and
   return a generic localized message (`error.generic`) plus `requestId` (and `traceId` if present)
   in the JSON body. Never return raw messages for 5xx.
3. Map Postgres/driver errors (codes 42703, 42P01, 57P01, ECONNRESET, CONNECTION_CLOSED, EPIPE)
   to 503 and SyntaxError from upstream JSON parsing to 502.
4. Update the OpenAPI error schema if it declares the error body, and docs/OBSERVABILITY.md.
5. Tests in apps/api/src/httpErrors.test.ts: unknown Error → 500 + generic message + requestId;
   ZodError → 400; known business message → its mapped 4xx; Postgres undefined-column → 503 and is
   logged at error level.

Acceptance: `npm test -w @localmeals/api` passes; a thrown `new Error("boom")` in a route returns
500 with no "boom" in the body and one error log line containing the stack.
```

### Prompt P1-4 — Schema-version gate and pipeline-only deploys

```text
Context: On 2026-11-23 an API revision was deployed manually (bypassing the migrate Cloud Run Job
in .github/workflows/deploy.yml) and served code ahead of the DB schema. packages/db uses
drizzle migrations (packages/db/drizzle, journal + __drizzle_migrations table).

Do:
1. In packages/db export `expectedMigrationCount()` (from the bundled drizzle journal) and
   `appliedMigrationCount(db)` (from drizzle.__drizzle_migrations).
2. In apps/api boot (apps/api/src/index.ts) and worker boot: if applied < expected and
   NODE_ENV=production, log `event=schema.behind` at error level and exit 1 (Cloud Run keeps the
   old revision). Allow override `ALLOW_SCHEMA_BEHIND=true` for emergencies.
3. Add a log-based metric + alert for `schema.behind` in infra/terraform/monitoring.tf.
4. Remove "Apply on Cloud SQL after each deploy" guidance from docs/PENDING.md; state that the
   pipeline's migrate job is the only supported path in docs/RUNBOOK.md §4.
5. (manual note in RUNBOOK) Restrict roles/run.admin / run.developer on the project to the GitHub
   deploy service account and break-glass group.

Acceptance: unit test for the count comparison; booting the API against a DB missing the latest
migration in production mode exits non-zero with a clear log line.
```

### Prompt P1-5 — Fix the pipeline and align runtime config

```text
Context: Deploy Cloud Run has failed 5 times on `next build` type errors because CI only runs
`tsc`. Repo variables MOCK_PAYMENTS/MOCK_AUTH/MOCK_WHATSAPP=true and AUTH_ENFORCE=false disagree
with the live API (mocks off, AUTH_ENFORCE=true, APP_ENV=staging). deploy.yml uses
--set-env-vars, which wipes env vars not listed (APP_ENV, LOG_LEVEL, ...).

Do:
1. In .github/workflows/ci.yml add a job that runs `docker build -f apps/web/Dockerfile .`
   (or `npm run build -w @localmeals/web` with fonts mocked/offline) on pull requests and main.
   Also add the same `next build` step to the deploy.yml test gate.
2. In deploy.yml add APP_ENV, LOG_LEVEL, DB_POOL_MAX to the API and worker env (from repo vars with
   safe defaults) and add `--startup-probe` / health settings once P1-6 lands.
3. Fail fast in deploy.yml before building images if MOCK_PAYMENTS != "false" or
   AUTH_ENFORCE == "false" (mirror apps/api/src/prodConfig.ts) with a clear message.
4. Document required repo variables and their production values in docs/INFRASTRUCTURE.md §5.
5. Fix the current web type error (`Parameter 'i' implicitly has an 'any' type`) so main deploys.

Acceptance: CI fails on a PR that breaks `next build`; deploy fails in <1 min with a clear message
when mock vars are set; a green deploy preserves APP_ENV and LOG_LEVEL on the new revision.
```

### Prompt P1-6 — Readiness endpoint and probes

```text
Context: apps/api/src/plugins/metaRoutes.ts `/health` returns {ok:true} without checks; the worker
health server (apps/worker/src/index.ts) always returns "ok". Uptime checks target /health.

Do:
1. Add `GET /ready` to the API: runs `select 1` (timeout 2s), compares migration counts (P1-4),
   and returns { ok, db, schema, outbox: { pending, oldestPendingAgeSec } } with 503 when db or
   schema fail. Keep /health as cheap liveness. Add both to QUIET_PATHS logging.
2. Worker: `GET /ready` checks DB reachability; return 503 on failure.
3. deploy.yml: add `--startup-probe=httpGet.path=/ready,...` and liveness on /health for api and
   worker.
4. monitoring_uptime.tf: point API uptime at /ready and add a second check on
   `/kitchens/<solo_kitchen_slug>/week?days=1` (content match on `"meals"` or similar).
5. Contract/OpenAPI + tests for /ready (db down → 503).

Acceptance: tests pass; with DB unavailable /ready returns 503 within 3s and /health still 200.
```

### Prompt P1-7 — Outbox visibility, replay, and worker job hygiene

```text
Context: apps/worker/src/drainOutbox.ts parks rows after OUTBOX_MAX_ATTEMPTS and marks
flag-off rows processed with no replay. apps/worker/src/index.ts fires expire-unpaid and retention
via fetch without checking res.ok and uses container-local (UTC) time for "03:00" / "21:00".

Do:
1. Worker: every drain cycle (and at most once a minute) log
   `event=outbox.backlog` with `pending` and `oldestPendingAgeSec`; add log metric (distribution or
   gauge-from-value) and alert when oldest age > 300s for 5m (infra/terraform/monitoring.tf).
2. Log parked rows with a distinct `event=outbox.parked` and alert on any occurrence.
3. API: `POST /admin/outbox/:id/retry` (ADMIN, audited via logAdmin) that clears processed_at /
   resets attempts for parked or flag-skipped rows; show a Retry button in Admin → Orders outbox list.
4. Worker scheduled calls: check `res.ok`, log `event=job.failed` with job name and status on
   failure; add an alert for `job.failed`.
5. Compute hour/minute in Asia/Kolkata explicitly (Intl.DateTimeFormat) for retention and
   auto-EOD; move default retention to 03:00 IST.
6. If WORKER_MODE=push and OUTBOX_WAKE_TOPIC is not configured on the API side, log a startup
   error; document in docs/COST.md that push mode requires `terraform apply` of worker_push.tf.
7. Tests for retry endpoint, res.ok handling, and IST slot calculation.

Acceptance: tests pass; a simulated parked row appears in Admin with a working Retry; logs carry
outbox.backlog every minute in poll mode.
```

### Prompt P1-8 — Third-party timeouts and retries

```text
Context: packages/adapters/src/payments.ts (Razorpay fetch ~line 157) and
packages/adapters/src/whatsapp.ts (sends ~141, media ~762/770) have no timeouts; non-JSON error
bodies throw SyntaxError. logistics.ts already uses an AbortController timeout.

Do:
1. Add a shared `fetchWithTimeout(url, init, { timeoutMs, retries, retryOn })` helper in
   packages/adapters with AbortSignal.timeout, safe JSON parsing (text fallback), and
   `third_party.request` logging (provider, path, status, durationMs, traceId).
2. Razorpay: timeout 10s (env RAZORPAY_TIMEOUT_MS), retry up to 2 times on network error/5xx/429
   only when an Idempotency-Key is present. Throw a typed `UpstreamError` with statusCode 502/503/504.
3. Meta: timeout 8s (env WHATSAPP_TIMEOUT_MS), no automatic retry (outbox already retries).
4. Add a log metric + alert for third_party.request with status >= 500 or timeout > N in 5m.
5. Unit tests using a stub server/mocked fetch: timeout → UpstreamError 504; HTML 502 body →
   UpstreamError 502 (no SyntaxError); retry happens only with idempotency key.

Acceptance: `npm test -w @localmeals/adapters` passes; API maps UpstreamError to 502/503/504 via
P0-3 classification.
```

### Prompt P1-9 — Support channels, request references, and status page

```text
Context: apps/web/src/lib/legal.ts reads NEXT_PUBLIC_LEGAL_* / NEXT_PUBLIC_SUPPORT_* at build time,
but apps/web/Dockerfile and .github/workflows/deploy.yml don't pass them (placeholders render).
Tickets are created via createOrderConcern / createTicketFromHelp (apps/api/src/services/admin.ts);
slaDueAt is set but never surfaced; ops are not notified; cooks have no ticket path; API error
responses don't surface request ids in the UI.

Do:
1. Add ARGs for every NEXT_PUBLIC_LEGAL_* and NEXT_PUBLIC_SUPPORT_* key to apps/web/Dockerfile and
   pass them from repo vars in deploy.yml. Fail the web build in production if
   legalDetailsMissing() is non-empty (env LEGAL_STRICT=true).
2. Web API client: when an API call fails, show "Reference: <requestId>" (from X-Request-Id header
   or body requestId from P0-3) in the error toast/message; include it in error.tsx alongside digest.
3. On ticket creation, enqueue an outbox event `TicketCreated` that WhatsApps ADMIN_MOBILES with
   ticket id, category, order publicId, and SLA due time.
4. Admin tickets list: sort/flag tickets past slaDueAt; add a worker check that logs
   `event=ticket.sla_breached` once per ticket and a Terraform alert on it.
5. Cook desk: "Report an issue" form creating a ticket with source=COOK and cookId (new nullable
   reporter field or source value); show in Admin tickets.
6. Customer orders page: show ticket status (OPEN/RESOLVED + decision) for the order.
7. Add `infra/status/index.html` (static: support phone/WhatsApp/email, "we're aware of an issue"
   banner text) and Terraform for a public GCS bucket hosting it; link it from docs/RUNBOOK.md.
8. Tests for ticket notification enqueue, SLA breach detection, and cook ticket creation.

Acceptance: production web build fails without legal details; /legal/contact shows real values;
creating a concern WhatsApps the admin; SLA-breached tickets are highlighted; status page URL is
documented in RUNBOOK.
```

### Prompt P1-10 — On-call, escalation, and incident process (docs)

```text
Context: docs/RUNBOOK.md §12 lists technical escalation steps only. There is one code owner, no
branch protection, no incident log, no postmortems.

Do:
1. Add docs/INCIDENTS.md with: severity matrix (SEV1 ordering/payments down in service window,
   SEV2 notifications/settlement degraded, SEV3 cosmetic), response targets, on-call roster
   placeholders (primary/backup, hours 07:30–14:00 and 20:30–22:00 IST), vendor escalation table
   (Razorpay, Meta, GCP support plan, domain/DNS) with placeholders, customer/cook WhatsApp comms
   templates (investigating / mitigated / resolved / refund notice), and a postmortem template.
2. Add the first postmortem entry: 2026-11-23 schema drift outage (timeline from revision
   localmeals-api-00032 created 06:01 UTC, errors 06:29–06:48 UTC on /kitchens and /me/*, root cause
   manual deploy without migration, detection gap, action items linking P0-2, P0-3, P1-4).
3. Update RUNBOOK.md §12 to reference INCIDENTS.md and add "Declare an incident" first steps.
4. Add .github/ISSUE_TEMPLATE/incident.yml and recurring-issue labels (incident, sev1-3, recurring).
5. Document (manual) branch protection for main: require CI, require PR, CODEOWNERS review once a
   second maintainer exists.

Acceptance: docs/INCIDENTS.md exists and is linked from docs/README.md and RUNBOOK.md; issue
template renders on GitHub.
```

### Prompt P2-11 — Capacity

```text
Context: Cloud SQL db-f1-micro ZONAL (~25 connections); API max-instances 5 with DB_POOL_MAX
(default 5) and worker pool 2; loadtest/cutoff-rush.js only run locally.

Do:
1. Add a `db_max_connections` input and a Terraform `check` block asserting
   api_max_instances*db_pool_max_api + worker_max_instances*db_pool_max_worker + 3 <=
   0.8*db_max_connections.
2. Document a tier upgrade path (db-g1-small → db-custom-1-3840) in docs/COST.md with cost deltas.
3. Extend loadtest/README.md with how to run cutoff-rush.js against the cloud API (rate-limit
   allowlist, test kitchen) and record p95/error thresholds as k6 `thresholds`.

Acceptance: terraform validate passes; plan fails when the connection budget is exceeded.
```

### Prompt P2-12 — Audit gaps

```text
Do:
1. Call logAdmin("RUN_EOD", ...) in POST /admin/settlements/run-eod and for internal-token calls to
   /internal/settlements/eod, /internal/cutoffs/*, /internal/ops/retention with actor
   "scheduler" or "worker" (pass via header X-Job-Caller, validated against an allowlist).
2. Switch Cloud Scheduler jobs to OIDC (service account) and make the API accept either a valid
   Google-signed OIDC token for the run SA or INTERNAL_JOB_TOKEN during migration.
3. Replace the hard-coded admin path in public docs with "configured via NEXT_PUBLIC_ADMIN_PATH".
Acceptance: tests show audit rows for EOD and cut-off with the correct actor.
```

### Prompt P2-13 — Retention

```text
Do:
1. Add docs/DATA_RETENTION.md: table-by-table (orders, payments, support_tickets,
   admin_action_log, platform_event_ledger, outbox, auth_*, uploads, Cloud Logging) period,
   legal basis (DPDP, tax, Razorpay disputes ≥ 120 days), and purge/redact method.
2. Raise platform_event_ledger retention to ≥ 180 days (PII_RETENTION_DAYS) or redact instead of
   delete; add redaction of customer mobiles in admin_action_log payloads older than the window;
   add support_tickets PII redaction after resolution + window.
3. Terraform: log sink of Cloud Run logs to a GCS bucket with 180-day retention.
4. Retention endpoint returns counts; worker logs `event=retention.completed` and Terraform alerts
   on absence for > 26h.
Acceptance: tests for new redaction paths; terraform validate passes; doc linked from README.
```

### Prompt P2-14 — Recovery drill and dashboard

```text
Do:
1. Add scripts/restore-drill.sh that clones localmeals-pg to a timestamped instance via PITR,
   waits until RUNNABLE, runs row-count checks through cloud-sql-proxy, prints elapsed time, and
   deletes the clone (with confirmation flag).
2. Add a "Restore drill log" table to docs/RUNBOOK.md §13 (date, who, RTO measured, issues).
3. Terraform: scheduled Cloud SQL export to a GCS bucket in a separate project (variable
   backup_export_bucket), weekly, with 90-day retention.
Acceptance: script passes shellcheck; terraform validate passes.
```
