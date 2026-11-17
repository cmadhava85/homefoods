# DAST (OWASP ZAP) — free

LocalMeals uses **OWASP ZAP** for free dynamic scanning of the API. This is **not** a paid pen-test; it catches common misconfigs and some attack classes against an ephemeral **mock** API.

## What runs

| Scan | Tool | Target |
|------|------|--------|
| Baseline | `zap-baseline.py` | Spider + **passive** rules on `http://localhost:4000` |
| API | `zap-api-scan.py` | Paths from [`.zap/openapi.yaml`](../.zap/openapi.yaml) (active checks — local/CI only) |

Rule noise for JSON APIs is tuned in [`.zap/rules.tsv`](../.zap/rules.tsv).

## Local

1. Start Postgres + API (mocks OK):

```bash
npm run db:migrate && npm run db:seed
npm run dev:api
```

2. In another terminal (Docker required):

```bash
npm run security:zap          # baseline (default)
npm run security:zap:api      # OpenAPI active scan
npm run security:zap:all      # both
```

Reports: `reports/zap/` (gitignored).

Override target if needed:

```bash
ZAP_TARGET=http://127.0.0.1:4000 npm run security:zap
```

**Do not** point ZAP at production.

### Notes (local Docker Desktop)

- Health wait accepts `http://127.0.0.1:4000/health` even when ZAP targets `host.docker.internal`.
- API root `/` returns 404 by design — baseline may WARN on cacheable 404 / missing `Sec-Fetch-Dest`; treat as noise unless FAIL alerts appear.
- Prefer `npm run security:zap` (baseline) for a quick green signal; `security:zap:api` is heavier and can OOM on small Docker Desktop memory — raise Docker RAM if the API scan exits with code 3.

## CI

[`.github/workflows/zap.yml`](../.github/workflows/zap.yml):

- Starts Postgres + migrates/seeds + runs the API
- Runs ZAP baseline + API scan
- Uploads artifacts (`zap-baseline`, `zap-api-scan`)
- Soft-fail for now (`continue-on-error` / `-I`) so noise doesn’t block merges while you tune rules

Triggers: `main`/`staging` API changes, weekly schedule, and manual `workflow_dispatch`.

## Limits

- No auth session in the default OpenAPI scan → protected routes mostly assert **401** behavior
- Baseline spider finds little HTML; OpenAPI drives most API coverage
- Expand `.zap/openapi.yaml` when you add public surfaces
- Paid pen-test remains the launch gate in [`SECURITY.md`](./SECURITY.md)
