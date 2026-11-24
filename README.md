# LocalMeals — MVP-1

Production monorepo for the HomeFood / LocalMeals lunch wedge.

**Scope:** one pin (600119), lunch, web + WhatsApp simulator, SELF delivery, mock UPI, cut-offs, EOD settlement, KYC/FSSAI LIVE gate, admin refunds/holds.

**UX reference:** `../homefood-design-demo`  

**Docs:** [Code tour](./docs/CODE_TOUR.md) · [Cost (solo)](./docs/COST.md) · [Handbook](./docs/HANDBOOK.md) · [Runbook](./docs/RUNBOOK.md) · [docs index](./docs/README.md) · [Technical design](./docs/TECHNICAL_DESIGN.md)

## Stack

- `apps/web` — Next.js
- `apps/api` — Fastify
- `apps/worker` — outbox poller + optional scheduled cut-off/EOD
- `packages/db` — Drizzle + Postgres (PostGIS optional)
- `packages/domain` — state machine, cut-offs, cook gates
- `packages/adapters` — mock payments / WhatsApp (+ real stubs)

## Quick start

```bash
cp .env.example .env
# Prefer Docker PostGIS; or local Postgres 16 with pgcrypto
docker compose up -d   # optional if you already have Postgres

npm install
npm run build -w @localmeals/domain
npm run build -w @localmeals/adapters
npm run build -w @localmeals/db
npm run db:migrate
npm run db:seed

npm run dev:api      # :4000
npm run dev:worker
npm run dev:web      # :3000
```

Open http://localhost:3000

Demo customer: `+919840111111` (seeded). Cook desk: `/cook/csk-homemade-delights`. Ops console path is configured via `NEXT_PUBLIC_ADMIN_PATH` (not linked publicly). WhatsApp sim: `/wa`.

Each cook sets their own lunch cut-off on the cook desk (`PATCH /cooks/:slug/cutoff`). Platform `LUNCH_CUTOFF_HOUR` / `MINUTE` is only the default for new cooks.

## Key API routes

See [docs/API.md](./docs/API.md).

## WhatsApp / payments

Local defaults: `MOCK_WHATSAPP=true`, `MOCK_PAYMENTS=true`.

For Meta WABA later set `MOCK_WHATSAPP=false` and:

- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

## Tests

```bash
npm test
```

Runs:
- `@localmeals/domain` — state machine, cut-offs, cook gates, money/idempotency
- `@localmeals/adapters` — WhatsApp intents, Maps URLs, mock payments
- `@localmeals/api` — integration + flows (order/pay/cut-off/pack/deliver, cancel, late path, refunds, EOD hold skip, WA Menu/Order/Pay/Help, webhooks) plus `opsFlows.e2e.test.ts` (worker outbox drain, week cart refund, post-cut-off cancel Accept, Child Pays, Admin support lookup)

## Handbook & runbook

- **[docs/HANDBOOK.md](./docs/HANDBOOK.md)** — product, roles, architecture, developer setup  
- **[docs/RUNBOOK.md](./docs/RUNBOOK.md)** — daily ops, deploy/rollback, incident playbooks  

## Deploy / infrastructure

**Start here:** [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md) — GCP, WhatsApp, Razorpay, GitHub Actions, and what *not* to buy yet.

**GCP as code:** [infra/terraform/README.md](./infra/terraform/README.md) (`home-food-513806`).

Short checklist: [docs/DEPLOY.md](./docs/DEPLOY.md).  
CI: `.github/workflows/ci.yml` (Postgres service + tests). Deploy: `.github/workflows/deploy.yml` (off until `ENABLE_GCP_DEPLOY=true`).
# homefoods
# homefoods
