# --- build: full deps + compile every workspace the API imports ---
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/adapters/package.json packages/adapters/
COPY packages/db/package.json packages/db/
COPY packages/i18n/package.json packages/i18n/
RUN npm ci -w @localmeals/api -w @localmeals/domain -w @localmeals/observability \
  -w @localmeals/adapters -w @localmeals/db -w @localmeals/i18n
COPY tsconfig.base.json ./
COPY packages/domain ./packages/domain
COPY packages/observability ./packages/observability
COPY packages/adapters ./packages/adapters
COPY packages/db ./packages/db
COPY packages/i18n ./packages/i18n
COPY apps/api ./apps/api
RUN npm run build -w @localmeals/domain \
 && npm run build -w @localmeals/observability \
 && npm run build -w @localmeals/adapters \
 && npm run build -w @localmeals/i18n \
 && npm run build -w @localmeals/db \
 && npm run build -w @localmeals/api

# --- prod-deps: production dependencies only (no tsx, stryker, types, test tools) ---
FROM node:26-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/adapters/package.json packages/adapters/
COPY packages/db/package.json packages/db/
COPY packages/i18n/package.json packages/i18n/
# OpenTelemetry SDKs are optionalDependencies (~100 MB); include only when tracing is on.
ARG WITH_OTEL=false
RUN OMIT_OPT=$([ "$WITH_OTEL" = "true" ] || echo "--omit=optional") \
 && npm ci --omit=dev $OMIT_OPT --ignore-scripts -w @localmeals/api -w @localmeals/domain \
  -w @localmeals/observability -w @localmeals/adapters -w @localmeals/db -w @localmeals/i18n \
 && npm cache clean --force

FROM node:26-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Kolkata
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/observability/dist ./packages/observability/dist
COPY --from=build /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=build /app/packages/i18n/dist ./packages/i18n/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
# Migration SQL for the localmeals-migrate Cloud Run Job (node packages/db/dist/migrate.js).
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/apps/api/dist ./apps/api/dist
# Run as the image's unprivileged user; only the local-uploads dir (dev/no-GCS fallback) is writable.
RUN mkdir -p /app/apps/api/uploads && chown node:node /app/apps/api/uploads
USER node
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
