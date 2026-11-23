FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/observability/package.json packages/observability/
COPY packages/adapters/package.json packages/adapters/
COPY packages/db/package.json packages/db/
RUN npm ci --omit=dev=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npm run build -w @localmeals/domain \
 && npm run build -w @localmeals/observability \
 && npm run build -w @localmeals/adapters \
 && npm run build -w @localmeals/db \
 && npm run build -w @localmeals/worker

FROM node:22-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Kolkata
COPY --from=build /app /app
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
