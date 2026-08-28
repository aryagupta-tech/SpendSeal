# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json

RUN npm ci

COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=43117 \
    HOST=0.0.0.0 \
    PUBLIC_BASE_URL=http://localhost:43117 \
    DATABASE_URL=postgresql://agentrail:agentrail@postgres:5432/agentrail \
    WEBAUTHN_RP_ID=localhost \
    WEBAUTHN_ORIGIN=http://localhost:43117 \
    WEBAUTHN_RP_NAME="SpendSeal"

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist

RUN chown -R node:node /app

USER node

EXPOSE 43117

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/v1/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
