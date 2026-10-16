# AFTERBYTE backend — Delivery Report

**Date:** 2026-10-16
**Scope:** Release A (receipt-anchored publishing) + Release B interfaces
(disabled) per the build brief. Token utility (Release C) stays off.
**Repo:** `/home/hatch/workspace/afterbyte` (pnpm workspaces, `pnpm@9.12.0`,
Node `>=20.18.0`, TypeScript `5.7.3`, vitest `3.2.4`).

Built in six parallel lanes, then integrated (this report's author): worker
shims replaced with real package adapters, OpenAPI conformance enforced by
test, workspace-wide verification, runbooks.

## 1. What was built per module

### apps/api — @afterbyte/api 0.1.0 (Fastify 5.12.7)
Public read API (dossiers, collections, search, stats, config, SSE stream),
wallet sign-in (challenge/verify, HttpOnly session cookie, CSRF), personal
endpoints (bookmarks, watchlist, submissions), and the admin surface:
draft lifecycle (create → submit-review → approve → publish → retract),
research runs, moderation tickets (submissions/corrections list + get +
moderate), uploads, ops, treasury-gated Release B endpoints (all 503 while
`PAYMENTS_ENABLED=false`). Permission check on every admin route; no-store
on all admin responses. **Integration added:** `GET /admin/submissions`,
`GET /admin/corrections` (list with status filter),
`POST /admin/awards` (503), `POST /admin/investigation-orders/{id}/accept`
(renamed from the wrong `/admin/orders/{id}/accept`, 503),
`POST /admin/investigation-orders/{id}/quote` (503).

### apps/worker — @afterbyte/worker 0.1.0 (BullMQ 5.81.5, ioredis 5.11.1, pg 8.23.1)
Queue processors (publish, anchor-receipt, research steps, maintenance,
notifications), receipt reconciler (derive → read → submit → confirm, RPC
fallback, tx-attempt audit), idempotent outbox, Postgres read models,
research run store. **Integration replaced** `src/shims/` (deleted) with
`src/adapters/` backed by the real packages:
- `adapters/solana.ts` → `@afterbyte/solana` (canonicalization delegated,
  never reimplemented; full `submitAnchor` flow with on-chain config read,
  subject sequencing check, `RestrictedPublisherSigner`; loud errors for
  missing program ID / signer / publication kind).
- `adapters/storage.ts` → `@afterbyte/storage` (`StorageClient`; public
  bucket for bundles, private bucket for snapshots; `null` when
  unconfigured — fails loudly, never fabricates).
- `adapters/research.ts` (+ `researchStore.ts`) → `@afterbyte/research`
  (real provider adapters, versioned prompt templates, lifecycle policy,
  schema validation + citation gate; `{providerUnavailable: true}` when
  keys are absent; hostile source text wrapped as data via `wrapAsData`).
- `publication_receipts` gained `publication_kind` (additive migration in
  `schema.sql`); the anchor pipeline threads it from draft payload to
  on-chain instruction.

### packages/solana — @afterbyte/solana 0.1.0 (@solana/web3.js 1.95.8)
ADR-0002 canonicalization (`hashPayload`, `deriveObjectKey`,
`HASH_SCHEMA_VERSION`), receipt-program client (config/publisher/subject/
receipt PDAs, `buildAppendReceiptTx`, `publicationKindToU8`),
`RestrictedPublisherSigner` (allowlisted `append_receipt` only, bounded
fees, field-verified args), standalone verifier, account parsers.

### packages/research — @afterbyte/research 0.1.0
Provider adapters (Website/RSS/GitHub) with conditional fetch, `ModelClient`
(OpenAI-compatible, schema validation + ≤2 repairs), versioned prompt
templates (`prompts/v1/`), lifecycle policy, budget ledger, dedup
(`urlFingerprint`), security (`wrapAsData`), citation gate.

### packages/storage — @afterbyte/storage 0.1.0
`StorageClient` (put/get/head/delete/list, public+private buckets),
canonical bundle helpers, upload intents.

### packages/contracts — @afterbyte/contracts 0.1.0
`openapi/v1.yaml` assembled from `openapi/paths/*.yaml` fragments
(`pnpm openapi:assemble`; CI fails on byte drift), generated
`src/types.ts` (`pnpm gen:types`), lint (`pnpm lint`).
**Contract is now 72 paths / 80 operations** (was 70/77 at lane end):
moved `PUT /me/bookmarks`, `PUT /me/watchlist` onto their `/{subjectId}`
paths (the old placement declared a path param not in the template),
added `POST /admin/drafts`, `GET /health/live`, `GET /health/ready`.
Conformance enforced by `apps/api/test/conformance.test.ts` (boots Fastify,
parses `printRoutes()`, asserts both directions, `:param`↔`{param}`).

### packages/database — @afterbyte/database 0.1.0 (drizzle-orm 0.45.4)
Drizzle schema + migrations + seed for the domain tables.

### packages/observability — @afterbyte/observability 0.1.0
Structured JSON logger used by API and worker.

### programs/afterbyte-receipts (Rust/Anchor)
Receipt program: `initialize_config`, `register_publisher`,
`initialize_subject` (admin signer), `append_receipt`,
`update_config`. Account sizes asserted at compile time
(Config 77, PublisherAuth 42, Subject 81, Receipt 164 bytes).

## 2. Test results (workspace-wide, 2026-10-16)

`pnpm -r typecheck` — **pass** (all packages).
`pnpm -r build` — **pass** (all JS/TS packages; Rust excluded, see below).

| Package | Result |
|---|---|
| packages/observability | 6/6 pass |
| packages/research | 99/99 pass |
| packages/solana | 67/67 pass |
| packages/contracts | 11/11 pass (fixtures validate; inventory 72 paths / 80 ops; lint OK) |
| apps/api | 57/57 pass (incl. 2 OpenAPI conformance tests) |
| apps/worker | 148/148 pass (incl. 7 new adapter tests proving real-package delegation) |
| packages/database | 33 pass, 8 skipped (DB integration tests skip without `DATABASE_URL` — expected) |
| packages/storage | 7/7 pass |
| programs/afterbyte-receipts | `anchor test` **not runnable here** — `anchor` CLI not installed (see BUILD.md; `cargo check` passes, 0 errors) |

## 3. VERIFIED vs UNVERIFIED

**Verified in this environment:**
- Full TypeScript typecheck + build across all JS/TS packages.
- All unit/integration test suites above green.
- OpenAPI ↔ Fastify route conformance in both directions (test).
- Contract fixture validation, fragment-assembler byte-stability, generated-types byte-stability.
- Worker adapter delegation: canonicalization output byte-identical to
  `@afterbyte/solana`; missing signer/program-ID/publication-kind all
  throw loudly; unconfigured storage/model providers degrade honestly.
- Rust `cargo check` on the receipt program: 0 errors (per BUILD.md, run
  2026-10-16 on this VM).

**NOT verified (no live infrastructure here):**
- No live Postgres/Redis — DB integration tests skipped; migrations not
  run against a real database.
- No live Solana RPC — `getReceiptAccount`, `getSignatureStatus`, and
  `submitAnchor`'s network path are unit-tested with fakes only.
- `anchor build` (BPF `.so`) and `anchor test` need Anchor CLI 0.30.1 —
  not installed here.
- Model transport unit-tested with fakes only — no real `MODEL_PROVIDER`
  call has been made.
- **No receipt-program deployment exists.** No program ID, no signature,
  and no receipt in this report or codebase is real. Anything resembling
  one in tests is a fixture.

## 4. Genuinely blocking missing inputs

Nothing ships to production without these (each fails loudly, never
silently, when absent):

- `SEARCH_PROVIDER_KEY` — discovery providers stay unavailable without it.
- `MODEL_PROVIDER_KEY` (+ `MODEL_PROVIDER_BASE_URL`, `MODEL_PROVIDER_MODEL_ID`) — research extract/draft stay in `awaiting_provider` without them.
- `SOLANA_RPC_URL` / `SOLANA_RPC_FALLBACK_URL` — receipt anchoring reports `unavailable` without them.
- `RECEIPT_PROGRAM_ID` — no on-chain anchoring possible until the program is deployed; **no program ID exists yet**.
- Treasury config (`TREASURY_PUBLIC_KEY`, `USDC_MINT`) + the ADR-0003
  payments checklist — `PAYMENTS_ENABLED` stays `false` until complete.
- Publisher signing: `PUBLISHER_SIGNER_REFERENCE` (production) — without
  it `submitAnchor` throws `PublisherSigningUnavailableError`.
- Admin bootstrap: the first administrator is assigned by the audited
  procedure in `docs/runbooks/deployment.md` (no self-signup path exists).

## 5. Standing constraints honored

No fabricated deployments, transactions, receipts, program IDs, or
signatures. No token issuance, ticker, or economics. Payments remain
flagged off. Handlers never invent data — degraded states are honest
(`providerUnavailable`, `503 FEATURE_UNAVAILABLE` / `PROVIDER_UNAVAILABLE`
with the standard failure envelope).

## 6. Docs

- `docs/runbooks/deployment.md` — environments, migrations, container
  deploy, admin bootstrap, payments-enablement checklist.
- `docs/runbooks/rollback-restore.md` — expand/contract discipline, PITR,
  object versioning, chain reconciliation after restore.
- `docs/runbooks/operator.md` — reconciler ops, dead-letter handling,
  provider outage playbook.
- `docs/frontend-integration.md` — bumped to 0.2; the "will be re-verified"
  caveat removed for the contract surface (now conformance-tested);
  honest caveats kept for unverified areas.
