# Mutation testing

Mutation testing rewrites production code in small ways (“mutants”) and checks whether tests fail. Survivors mean a change wasn’t caught — usually a **missing assertion** or **untested branch**, not just “line not executed.”

We use [StrykerJS](https://stryker-mutator.io/).

## What is covered

| Package | Config | Mutates | Tests |
|---------|--------|---------|-------|
| `@localmeals/domain` | `packages/domain/stryker.config.json` | All domain `src/**` (excludes `*.test.ts`) | Existing `node:test` suite via `tsc` + `node --test` |
| `@localmeals/api` (default) | `apps/api/stryker.config.json` | `httpErrors`, `prodConfig`, `http/orderViews`, `uploads`, `turnoverReports` | Fast unit tests (`npm run test:unit`) |
| `@localmeals/api` (full) | `apps/api/stryker.full.config.json` | Nearly all API `src/**` | Full API suite (slow; needs DB) |
| `@localmeals/web` | `apps/web/stryker.config.json` | Pure `src/lib/**` helpers | Vitest unit tests |

**Not mutated yet (by design):** Next.js `app/` / `components/` pages (no component unit suite), WhatsApp handlers, large `services/orders.ts` in the *default* API profile. Expand mutate globs after adding faster unit tests for those areas.

## Commands

```bash
# Domain business rules (recommended first)
npm run test:mutation -w @localmeals/domain

# API security/authz helpers (fast)
npm run test:mutation -w @localmeals/api

# API full surface (slow)
npm run test:mutation:full -w @localmeals/api

# Frontend lib helpers
npm run test -w @localmeals/web
npm run test:mutation -w @localmeals/web

# All default profiles
npm run test:mutation
```

HTML reports land under each package’s `reports/mutation/`.

## Interpreting results

- **Killed** — tests caught the mutant (good).
- **Survived** — add or strengthen a test for that branch.
- **No coverage** — no test exercised that code; write a unit test before chasing score.
- **Timeout** — often an infinite loop mutant; investigate if frequent.

Thresholds are advisory (`break: null`) so mutation runs don’t fail CI while you grow coverage. Raise `thresholds.break` once scores stabilize.

## Latest scores (advisory)

| Package | Mutation score | Notes |
|---------|----------------|-------|
| `@localmeals/domain` | **90.4%** | cookGates / reviews / weekDiscount at 100% |
| `@localmeals/api` (default) | **74.4%** | Pure helpers; DB/GCS I/O in `getTurnoverReport` / `uploadsIo` not mutated |
| `@localmeals/web` | **92.5%** | `src/lib/**` helpers only |

## CI

`security:check` stays separate. Mutation is **opt-in** (can take many minutes). Optionally add a nightly job running `npm run test:mutation -w @localmeals/domain`.
