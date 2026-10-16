# AFTERBYTE worker — BullMQ job-processing runtime
# Multi-stage build; runs as non-root; Redis/Postgres are external services.

FROM node:20.18-slim AS build
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
# Workspace root manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @afterbyte/worker...
COPY apps/worker apps/worker
RUN pnpm --filter @afterbyte/worker build

FROM node:20.18-slim AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml ./
COPY --from=build /repo/apps/worker/package.json ./apps/worker/
RUN pnpm install --frozen-lockfile --prod --filter @afterbyte/worker...
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
RUN useradd -m -u 10001 worker && chown -R worker:worker /app
USER worker
ENV NODE_ENV=production
WORKDIR /app/apps/worker
# Required at runtime: DATABASE_URL, REDIS_URL.
# Optional capabilities: SOLANA_RPC_URL (+_FALLBACK), RECEIPT_PROGRAM_ID,
# STORAGE_ENDPOINT/BUCKET, PAYMENTS_ENABLED (+TREASURY_ADDRESS, USDC_MINT_ADDRESS).
CMD ["node", "dist/src/index.js"]
