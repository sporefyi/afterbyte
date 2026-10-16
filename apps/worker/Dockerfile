# AFTERBYTE worker — BullMQ job-processing runtime
# Multi-stage build; runs as non-root; Redis/Postgres are external services.

FROM node:20.18-slim AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
# Workspace root manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/database/package.json packages/database/
COPY packages/observability/package.json packages/observability/
COPY packages/research/package.json packages/research/
COPY packages/solana/package.json packages/solana/
COPY packages/storage/package.json packages/storage/
RUN pnpm install --frozen-lockfile --filter @afterbyte/worker...

FROM base AS build
# Copy the whole deps layer (preserves pnpm's per-package node_modules links),
# then overlay the full source.
COPY --from=deps /repo /repo
COPY . .
# The `...` builds the worker plus all of its workspace dependencies, topologically.
RUN pnpm --filter @afterbyte/worker... build
RUN pnpm --filter @afterbyte/worker deploy /srv/worker-deploy --prod

FROM node:20.18-slim AS runtime
WORKDIR /srv/worker
COPY --from=build /srv/worker-deploy ./
RUN useradd -m -u 10001 worker && chown -R worker:worker /srv/worker
USER worker
ENV NODE_ENV=production
# Required at runtime: DATABASE_URL, REDIS_URL.
# Optional capabilities: SOLANA_RPC_URL (+_FALLBACK), RECEIPT_PROGRAM_ID,
# STORAGE_ENDPOINT/BUCKET, PAYMENTS_ENABLED (+TREASURY_ADDRESS, USDC_MINT_ADDRESS).
CMD ["node", "dist/src/index.js"]
