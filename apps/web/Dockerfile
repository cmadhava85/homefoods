FROM node:26-alpine AS deps
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
# Legal / support identity (baked into /legal/* at build time).
ARG NEXT_PUBLIC_LEGAL_ENTITY_NAME=
ENV NEXT_PUBLIC_LEGAL_ENTITY_NAME=$NEXT_PUBLIC_LEGAL_ENTITY_NAME
ARG NEXT_PUBLIC_LEGAL_ADDRESS=
ENV NEXT_PUBLIC_LEGAL_ADDRESS=$NEXT_PUBLIC_LEGAL_ADDRESS
ARG NEXT_PUBLIC_LEGAL_GSTIN=
ENV NEXT_PUBLIC_LEGAL_GSTIN=$NEXT_PUBLIC_LEGAL_GSTIN
ARG NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE=
ENV NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE=$NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE
ARG NEXT_PUBLIC_SUPPORT_EMAIL=
ENV NEXT_PUBLIC_SUPPORT_EMAIL=$NEXT_PUBLIC_SUPPORT_EMAIL
ARG NEXT_PUBLIC_SUPPORT_PHONE=
ENV NEXT_PUBLIC_SUPPORT_PHONE=$NEXT_PUBLIC_SUPPORT_PHONE
ARG NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME=
ENV NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME=$NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME
ARG NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL=
ENV NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL=$NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL
# Fail the production image build when required legal env vars are missing.
ARG LEGAL_STRICT=
ENV LEGAL_STRICT=$LEGAL_STRICT
RUN npm run build -w @localmeals/domain \
 && npm run build -w @localmeals/i18n \
 && npm run build -w @localmeals/web

FROM node:26-alpine
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
