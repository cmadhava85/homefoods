# Data retention

Per-table schedule for LocalMeals (DPDP purpose limitation, tax/bookkeeping, Razorpay disputes ≥ ~120 days). Purge/redact runs via `POST /internal/ops/retention` (worker 03:00 IST when `ENABLE_AUTO_RETENTION` ≠ false). Default window: **`PII_RETENTION_DAYS=180`** (was 90 — too short for payment disputes).

| Store | Period | Legal / ops basis | Method |
|-------|--------|-------------------|--------|
| `orders` / `payments` / `refunds` / `settlements` | Keep (no auto-delete) | Tax, cook payouts, Razorpay disputes | Retain; account-deletion path redacts customer fields separately |
| `platform_event_ledger` | **180 d** then delete (or redact-mode) | Ops trace + dispute window | `purge` deletes; `mode=redact` nulls mobiles / payload keys |
| `admin_action_log` | Payloads scrubbed after **180 d**; rows kept | Audit trail | Redact mobile-like JSON keys; do not delete rows by default |
| `support_tickets` | Customer mobile redacted **180 d after resolve/close** | Support + DPDP minimisation | Null `customer_mobile`; keep summary / order FK |
| `outbox` (processed) | **180 d** | Ephemeral delivery | Hard delete processed rows |
| `auth_otps` | At `expires_at` | Auth hygiene | Hard delete |
| `auth_revocations` | **8 d** | Session revoke window | Hard delete |
| `wa_checkout_sessions` | At `expires_at` | Checkout hygiene | Hard delete |
| `rate_limit_buckets` | When expired | Abuse control | Hard delete |
| GCS concern photos (`uploads`) | Nearline 30 d / delete **180 d** | Evidence then minimise | Bucket lifecycle (`uploads_*_days`) |
| Menu photos (public bucket) | Keep while live | Product | Manual / cook lifecycle |
| Cloud Logging `_Default` | **30 d** (GCP default) | Ops | Copy via log sink → GCS **180 d** (`log_archive_enabled`) |
| Cloud SQL backups / PITR | 14 daily + **7 d** WAL | RTO/RPO | See [RUNBOOK.md](./RUNBOOK.md) §13 |

## Env

| Variable | Default | Notes |
|----------|---------|-------|
| `PII_RETENTION_DAYS` | **180** | Must stay ≥ 180 for dispute buffer unless legal signs off on redaction-only |
| `ENABLE_AUTO_RETENTION` | on (≠ `false`) | Worker daily job |

## Success signal

Worker logs `event=retention.completed` after a successful purge (counts in payload). **Alert note:** add a Cloud Monitoring absence policy on that event for **> 26 h** once `alert_email` is live (metric stub in `infra/terraform/monitoring.tf` / log archive README). Until then, grep Logging for `retention.completed` after 03:00 IST.

## Related

- [SECURITY.md](./SECURITY.md) — PII checklist  
- [RUNBOOK.md](./RUNBOOK.md) — manual retention curl  
- [COST.md](./COST.md) — GCS lifecycle  
