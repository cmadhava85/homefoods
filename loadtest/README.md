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

**Thresholds (fail the run):** error rate < 1 %, read p95 < 500 ms / p99 < 1.5 s, order create p95 < 1.5 s.
409 / capacity rejections are business outcomes, not errors (`orders_rejected_capacity`).

**Before launch**, run against a staging copy sized like production (same `db_tier`, `DB_POOL_MAX`, `max-instances`) and record results in
`docs/RUNBOOK.md`. Watch Cloud SQL `num_backends` (alert at 20 on f1-micro) and CPU: the global rate limiter uses the Postgres store
(one upsert per request), so DB write load scales with *all* traffic, not just orders.
