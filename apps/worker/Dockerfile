# --- build: full deps + compile ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/adapters/package.json packages/adapters/
COPY packages/db/package.json packages/db/
RUN npm ci -w @localmeals/worker -w @localmeals/domain -w @localmeals/observability \
  -w @localmeals/adapters -w @localmeals/db
COPY tsconfig.base.json ./
COPY packages/domain ./packages/domain
COPY packages/observability ./packages/observability
COPY packages/adapters ./packages/adapters
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker
RUN npm run build -w @localmeals/domain \
 && npm run build -w @localmeals/observability \
 && npm run build -w @localmeals/adapters \
 && npm run build -w @localmeals/db \
 && npm run build -w @localmeals/worker

# --- prod-deps: production dependencies only ---
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/adapters/package.json packages/adapters/
COPY packages/db/package.json packages/db/
# OpenTelemetry SDKs are optionalDependencies (~100 MB); include only when tracing is on.
ARG WITH_OTEL=false
RUN OMIT_OPT=$([ "$WITH_OTEL" = "true" ] || echo "--omit=optional") \
 && npm ci --omit=dev $OMIT_OPT --ignore-scripts -w @localmeals/worker -w @localmeals/domain \
  -w @localmeals/observability -w @localmeals/adapters -w @localmeals/db \
 && npm cache clean --force

FROM node:22-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Kolkata
COPY --from=prod-deps /app /app
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/observability/dist ./packages/observability/dist
COPY --from=build /app/packages/adapters/dist ./packages/adapters/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
USER node
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
