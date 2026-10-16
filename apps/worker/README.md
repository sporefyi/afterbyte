# @afterbyte/worker

BullMQ 5 job-processing runtime for the AFTERBYTE research/publication pipeline
(brief §8, ADR-0001). Durable state lives in Postgres; Redis is transport only.

## Queues (13)

`discovery`, `fetch`, `extract`, `draft`, `review-preflight`, `publish`,
`anchor-receipt`, `recheck-receipt`, `refresh-read-models`, `render-share-card`,
`reconcile-payment`, `reconcile-refund`, `maintenance`.

Queue payloads hold **IDs + schema versions, never whole private articles**.
Every payload carries a deterministic `jobKey` (see `jobKeys` in
`src/queues.ts`).

## Reliability model

- **Business dedup** is the `job_records` Postgres table, never BullMQ rows.
  A record with status `succeeded` makes duplicate deliveries no-ops even
  after the BullMQ job row was removed (`removeOnComplete`/`removeOnFail`).
  BullMQ retries of the *same* job re-run the work — every handler must be
  idempotent (DB uniqueness, `versionExists` checks, on-chain state checks
  before submitting).
- **Outbox**: domain mutation + outbox events commit in ONE transaction.
  `dispatchOutboxTick` (every `OUTBOX_POLL_INTERVAL_SEC`) claims due events
  (`FOR UPDATE SKIP LOCKED`), enqueues with deterministic BullMQ `jobId =
  outbox:<eventId>` (redispatch never double-enqueues), and marks dispatched.
  Public SSE event types go to the durable `public_events` table instead of a
  queue. Delivery is at-least-once; consumers dedup via `handled_events`.
- **Crash recovery** (`reconcileOutboxAfterCrash`, runs at startup):
  dispatched-but-unacked events older than `OUTBOX_STUCK_AFTER_SEC` return to
  pending (bounded by a redelivery budget, then failed for manual review);
  `running` jobs with stale heartbeats are marked `interrupted`.
- **Retries**: 3 attempts, exponential backoff + jitter
  (`src/backoff.ts`), provider `Retry-After` honored via `TransientError`
  (or `job.data.retryAfterMs`). `PermanentError` (schema/permission) →
  BullMQ `UnrecoverableError` → dead letter / failed review, never retried.
- **Financial guard**: `ensureTransferSettled` determines whether an earlier
  transfer settled before any new transaction is built. A timeout never
  produces a second payout while the first may have finalized.
- **Leases** (`src/leases.ts`) + cancellation tokens for long steps;
  graceful shutdown on SIGTERM/SIGINT; worker heartbeat rows.

## Publish flow (brief §9)

`publish` processor: load draft → idempotency check (`versionExists`) →
canonicalize via `@afterbyte/solana` (**never reimplemented here**) → object
write + SHA-256 digest verify → **ONE transaction**: immutable version row +
current-version pointer + outbox events (`receipt.anchor.requested`,
`readmodel.refresh.requested`, `sharecard.render.requested`,
`dossier.published`). The DB commit is the publication authority.

## Receipt reconciliation (brief §10)

`src/reconciler.ts`: every tx attempt is persisted **before** submission. On
timeout, the reconciler queries the signature status **and** the deterministic
receipt account before retrying. States are honest:
`pending|submitted|confirmed|failed|unavailable` — never fabricated.
`finalized` is required for the public "Recorded on Solana" badge; `confirmed`
may be shown as pending-finality. RPC fallback: primary, then
`SOLANA_RPC_FALLBACK_URL`. Retrying an existing receipt with the same payload
is success; a different payload for the same version is a `payload-conflict`
failure.

## Read models (brief §14)

`src/readmodels.ts`: home / collection / stats built from **published data
only** — aggregate counts exclude rejected/unpublished; `recorded` =
versions with finalized receipts. Every materialization stores `asOf` + the
source revision.

## Admin visibility

`src/queueHealth.ts` exports `listDeadLetterJobs`, `getQueueOverview`,
`retryDeadLetterJob`, `discardDeadLetterJob` — the API lane's `/queues` +
`/audit-log` endpoints call these. Discarding a BullMQ job never erases the
`job_records` dedup.

## Configuration

Required: `DATABASE_URL`, `REDIS_URL`. Optional capabilities degrade
honestly: `SOLANA_RPC_URL` (+`_FALLBACK_URL`), `RECEIPT_PROGRAM_ID`,
`STORAGE_ENDPOINT`/`STORAGE_PUBLIC_BUCKET`, `SEARCH_PROVIDER_KEY`,
`MODEL_PROVIDER_KEY`. `PAYMENTS_ENABLED=true` additionally requires
`TREASURY_ADDRESS` + `USDC_MINT_ADDRESS` or startup fails (ADR-0003).

## Lane handoffs (shims to delete)

- `src/shims/solana.ts` → `@afterbyte/solana` (canonicalization, receipt
  PDAs, publisher signing boundary). **Do not reimplement canonicalization.**
- `src/shims/research.ts` → `@afterbyte/research` (pipeline steps).
- `src/shims/storage.ts` → `@afterbyte/storage` (object writes).
- `src/pg.ts` + `src/schema.sql` → `@afterbyte/database` (Drizzle schema;
  table/column names here are the worker's requirement contract).
- Until they land, jobs needing those capabilities throw clear errors naming
  the missing package — the worker boots, but refuses to fabricate results.

## Tests

`pnpm test` (vitest). Unit tests run on in-memory fakes — no Postgres/Redis.
The BullMQ integration test uses `ioredis-mock` and skips gracefully if the
mock can't drive BullMQ here. Live-Redis tests are skipped without
`REDIS_URL`.
