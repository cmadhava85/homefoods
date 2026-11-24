# Load tests (k6)

`cutoff-rush.js` models the busiest minutes: customers browsing and ordering just before a kitchen's lunch cut-off.

| Scenario | What it does | Safe on production? |
|---|---|---|
| `browse` | `/kitchens`, menu, week view, feature flags | Yes (read-only), but coordinate first — it consumes real Cloud Run/DB capacity |
| `order` (`ALLOW_WRITES=true`) | OTP login (mock), save address, `POST /orders`, cancel | **No** — needs `MOCK_AUTH=true`, `MOCK_PAYMENTS=true` (local or a disposable staging copy) |

```bash
# Local API (npm run dev:api) — no k6 install needed
docker run --rm -i -e BASE_URL=http://host.docker.internal:4000 grafana/k6 run - < loadtest/cutoff-rush.js
docker run --rm -i -e BASE_URL=http://host.docker.internal:4000 -e ALLOW_WRITES=true -e PEAK_VUS=60 \
  grafana/k6 run - < loadtest/cutoff-rush.js
```

Knobs: `PEAK_VUS` (default 50), `KITCHEN_SLUG`, `BASE_URL`, `QUICK=true` (30 s script check).

## k6 thresholds (fail the run)

Defined in `cutoff-rush.js` `options.thresholds`:

| Metric | Threshold |
|--------|-----------|
| `http_req_failed` | `rate<0.01` (error rate &lt; 1 %) |
| `http_req_duration{kind:read}` | `p(95)<500`, `p(99)<1500` (ms) |
| `order_create_ms` (writes only) | `p(95)<1500` |

409 / capacity rejections are business outcomes, not errors (`orders_rejected_capacity`). k6 exits non-zero when any threshold fails.

## Against Cloud Run (staging)

1. **Target** a staging API sized like production (`db_tier`, `DB_POOL_MAX`, `api_max_instances` / worker pools). Prefer a disposable project or a sleep-wake staging DB — never `ALLOW_WRITES=true` on live kitchens with real payments.
2. **Rate-limit allowlist / headroom:** every VU shares the k6 machine’s egress IP, so per-IP global limits (`RATE_LIMIT_MAX`) and OTP buckets apply to the whole test. For a capacity run, temporarily raise `RATE_LIMIT_MAX` on the API revision (or set `RATE_LIMIT_GLOBAL_STORE=memory` already default) and ensure mock OTP is on (`MOCK_AUTH=true`).
3. **Test kitchen:** use a dedicated slug (`KITCHEN_SLUG=…`) that is LIVE with menu for today and enough capacity; for writes, `MOCK_PAYMENTS=true` so cancels do not hit Razorpay.
4. **Auth to the URL:** Cloud Run services that require IAM need an identity token, or run against a publicly invokable staging URL / load-balancer. Example with public staging:

```bash
API_URL="https://localmeals-api-xxxxx-as.a.run.app"   # or custom api.* domain
docker run --rm -i \
  -e BASE_URL="$API_URL" \
  -e KITCHEN_SLUG=csk-homemade-delights \
  -e PEAK_VUS=40 \
  grafana/k6 run - < loadtest/cutoff-rush.js

# Writes only on mock staging:
docker run --rm -i \
  -e BASE_URL="$API_URL" \
  -e ALLOW_WRITES=true \
  -e PEAK_VUS=30 \
  -e KITCHEN_SLUG=csk-homemade-delights \
  grafana/k6 run - < loadtest/cutoff-rush.js
```

5. **Watch while it runs:** Cloud SQL `num_backends` (alert near `db_connections_alert_threshold` / 80 % of `db_max_connections`), Cloud Run CPU/request latency, and connection-budget headroom from Terraform (`docs/COST.md`).
6. **Record** date, `PEAK_VUS`, pass/fail thresholds, p95, and `num_backends` peak in [docs/RUNBOOK.md](../docs/RUNBOOK.md) (Observability / capacity notes).

**Before launch**, run browse (and optionally writes on mock staging) and keep results next to the restore-drill log.
