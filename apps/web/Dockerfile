FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/i18n/package.json packages/i18n/
COPY packages/domain/package.json packages/domain/
COPY packages/adapters/package.json packages/adapters/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
RUN npm ci -w @localmeals/web -w @localmeals/i18n -w @localmeals/domain

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/i18n ./packages/i18n
COPY packages/domain ./packages/domain
COPY apps/web ./apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Temporary single-kitchen launch (optional; leave empty for multi-cook).
ARG NEXT_PUBLIC_SOLO_KITCHEN_SLUG=
ENV NEXT_PUBLIC_SOLO_KITCHEN_SLUG=$NEXT_PUBLIC_SOLO_KITCHEN_SLUG
ARG NEXT_PUBLIC_HIDE_COOK_ONBOARD=
ENV NEXT_PUBLIC_HIDE_COOK_ONBOARD=$NEXT_PUBLIC_HIDE_COOK_ONBOARD
# Public GCS base for menu photos (empty = serve through the API).
ARG NEXT_PUBLIC_MENU_IMAGES_BASE=
ENV NEXT_PUBLIC_MENU_IMAGES_BASE=$NEXT_PUBLIC_MENU_IMAGES_BASE
RUN npm run build -w @localmeals/domain \
 && npm run build -w @localmeals/i18n \
 && npm run build -w @localmeals/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# standalone = server.js + only the node_modules files Next traced as needed at runtime.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
WORKDIR /app/apps/web
EXPOSE 3000
# Next standalone reads PORT; exec form so SIGTERM from Cloud Run reaches node directly.
CMD ["node", "server.js"]
