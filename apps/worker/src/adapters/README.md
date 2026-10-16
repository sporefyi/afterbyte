# Worker adapters — real packages behind the former shims

`src/shims/` (unimplemented throwers) was deleted. Each adapter below implements
the interface the worker codes against, backed by the real lane packages.
`apps/worker/src/index.ts` wires them in `buildDeps`.

## solana.ts — @afterbyte/solana

- `canonicalizePublicationPayload` delegates to the package's `hashPayload` +
  `deriveObjectKey`. The worker never reimplements canonicalization (ADR-0002).
- `deriveReceiptAddress` uses `deriveSubjectId` + `findReceiptPda`; throws loudly
  when `RECEIPT_PROGRAM_ID` is unset.
- `getReceiptAccount` / `getSignatureStatus` are plain JSON-RPC calls
  (`getAccountInfo`, `getSignatureStatuses`); transport/RPC errors throw so the
  reconciler's `withRpcFallback` can try the next RPC.
- `submitAnchor`:
  - Reads the on-chain config for the governing `schema_version`.
  - Resolves `previousPayloadHash` from the Subject account (missing subject +
    v1 → 32 zero bytes; missing subject + vN>1 → loud error telling the
    operator an administrator must call `initialize_subject` — the publisher
    cannot, the program requires the admin signer).
  - Requires `publicationKind` (the anchor-receipt job carries it from the
    draft's canonical payload; the program validates the discriminant).
  - Signs through `RestrictedPublisherSigner` (allowlisted `append_receipt`
    only, bounded fees, every arg field verified against the approved append).
  - The `SignFn` is injected. When absent, `submitAnchor` throws
    `PublisherSigningUnavailableError`. `PUBLISHER_KEYPAIR_PATH` enables a
    local-dev file-backed signer only (refused in production without
    `PUBLISHER_ALLOW_FILE_SIGNER=1`).

## storage.ts — @afterbyte/storage

- The `StoragePackage` interface methods operate on the PUBLIC bucket
  (canonical bundles, share cards).
- `putPrivateObject` / `getPrivateObject` / `deletePrivateObjects` on the
  class serve the private bucket (source snapshots, quarantine).
- `createStorageAdapter()` returns `null` when object storage is unconfigured;
  `buildDeps` then keeps the loud `notYet` proxy so storage-backed jobs fail
  with a clear error instead of fabricating results.

## research.ts — @afterbyte/research

Composes the real primitives: `WebsiteAdapter` / `RssAdapter` / `GitHubAdapter`,
`ModelClient` + versioned prompt templates (`prompts/v1`), the lifecycle
policy, `wrapAsData` (hostile source text is quoted data, never instructions),
`validateSchema` / `citationGateDecision`, and the dedup helpers.

- `runDiscoveryStep` — provider `health()` gate, `discover()` per provider,
  URL-fingerprint dedup, source rows, `research.source.fetch.requested`
  outbox events. All providers down → `{ providerUnavailable: true }`.
- `runFetchStep` — conditional-capable `fetch()`, raw bytes to the private
  bucket, `normalize()` excerpt persisted, `research.snapshot.extract.requested`
  event. Non-retryable fetch errors become coverage gaps, not failures.
- `runExtractStep` — `extract-facts` template via `ModelClient` (schema
  validation + ≤2 repairs inside the client), facts persisted with
  claim kinds (`sourced_fact` / `inference` / `disputed`).
- `runDraftStep` — lifecycle proposal from the versioned policy (thin
  evidence → `uncertain`, never `discontinued` on missing data),
  `draft-sections` template, draft persisted, `editorial.review.preflight.requested`
  event.
- `runReviewPreflight` — structural validation (failure → `PermanentError`,
  no retry) + citation gate (unsupported dates/quantities/allegations →
  `PermanentError`).

Model transport: `MODEL_PROVIDER_KEY` + `MODEL_PROVIDER_BASE_URL` +
`MODEL_PROVIDER_MODEL_ID` (OpenAI-compatible `/chat/completions`). Any absent
→ `{ providerUnavailable: true }`; runs stay `awaiting_provider`.

Persistence: worker-owned tables in `src/schema.sql`
(`research_runs`, `research_sources`, `research_snapshots`, `research_facts`,
`research_drafts`) via `researchStore.ts`. They mirror `packages/database`'s
research tables; the two should converge on the Drizzle client in a later
pass. Steps are idempotent (`INSERT ... ON CONFLICT DO NOTHING`).

Known gaps (not silent):
- The API process creates research runs in its own memory (`AdminStore`);
  the worker's adapter owns separate run rows. Cross-process run handoff
  (API → worker queue with a shared run record) is not yet wired — use the
  adapter's `registerRun` (ops tooling) to seed a run before dispatching
  discovery, or extend the discovery job envelope later.
- Draft jobs are enqueued by the editorial flow; the extract step emits no
  draft event on its own.
