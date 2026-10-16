# AFTERBYTE API — multi-stage build (repo-root context, see docker-compose.yml).
FROM node:24-slim AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/observability/package.json packages/observability/
COPY packages/storage/package.json packages/storage/
RUN pnpm install --frozen-lockfile --filter @afterbyte/api...

FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN pnpm --filter @afterbyte/observability --filter @afterbyte/storage --filter @afterbyte/api build
RUN pnpm --filter @afterbyte/api deploy /srv/deploy --prod

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/api
COPY --from=build /srv/deploy ./
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
