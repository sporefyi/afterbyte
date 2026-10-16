# ADR-0001 — Stack and module boundaries

Status: accepted · 2026-10-16

## Decision

- Monorepo: pnpm workspaces, `apps/*`, `packages/*`, `programs/*`.
- API: Fastify 5 (JSON Schema validation via AJV, hooks for auth/logging), SSE via
  `fastify-sse`-style streaming (pinned; fallback to raw stream if unmaintained).
- ORM: Drizzle (`drizzle-orm` + `drizzle-kit`), `pg` driver, UUID PKs, `timestamptz` UTC.
- Queues: BullMQ 5 + ioredis; queue names per brief §8 (`discovery`, `fetch`,
  `extract`, `draft`, `review-preflight`, `publish`, `anchor-receipt`,
  `recheck-receipt`, `refresh-read-models`, `render-share-card`, `reconcile-payment`,
  `reconcile-refund`, `maintenance`).
- Storage: S3-compatible (MinIO locally), public + private buckets.
- Solana: Anchor (pinned, e.g. 0.30.x) for `programs/afterbyte-receipts`;
  `@solana/web3.js` v1 pinned for the TS client; a signer-isolation module keeps the
  receipt-publisher signing boundary separate from research code.
- Tests: Vitest; contract tests assert OpenAPI matches handlers and fixtures validate.

## Rationale

Modular monolith: one repo, three deployable processes (api, worker, program), shared
domain services. Business rules in `packages/*`; handlers and job processors both call
the same functions, so authorization and state transitions cannot drift.

## Consequences

- All lanes pin exact versions and commit lockfiles (`pnpm-lock.yaml`).
- `packages/contracts` OpenAPI is checked in and frozen per milestone; breaking
  changes fail CI by design (contract tests).
- Redis is transport/cache only; durable business state lives in Postgres so Redis
  loss is recoverable — handlers must be idempotent and re-derivable.
