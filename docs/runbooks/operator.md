# Operator runbook

Day-to-day operations for the AFTERBYTE backend. Audience: the person on
call. All worker behavior below is in `apps/worker`; API behavior in
`apps/api`.

## 1. Receipt reconciler ops

The reconciler (`apps/worker/src/reconciler.ts`) keeps `publication_receipts`
in sync with chain state.

**Normal states:** `pending` → `submitted` → `confirmed` → `finalized`.
`failed` and `unavailable` are terminal-for-now (see below).

**What to watch:**

| Signal | Meaning | Action |
|---|---|---|
| `submitted` older than 10 min | Confirmation not observed | Recheck sweep will retry `getSignatureStatus`; no action unless persistent |
| `failed` | All RPCs failed or submission rejected | Inspect `tx_attempts` error column; fix RPC/config; re-queue `anchor-receipt` |
| `unavailable` | No RPC configured or provider down at submit time | Configure `SOLANA_RPC_URL`; re-queue |
| `pending` growing | Worker not picking up `receipt.anchor.requested` | Check worker liveness, Redis, queue depth |

**Re-anchoring is safe:** `anchorReceipt` re-derives the receipt address and
reads the on-chain account before submitting. If a receipt account already
exists for the version, it adopts it instead of submitting a duplicate.

**Manual re-queue** (example — re-anchor subject `sub_1` version 3):

```sql
-- the anchor-receipt processor reads the outbox; simplest is to re-emit:
INSERT INTO outbox (event_type, payload)
VALUES ('receipt.anchor.requested',
        '{"subjectId":"sub_1","versionNumber":3,"payloadHash":"<hash>","publicationKind":"amendment"}'::jsonb);
```

The `publicationKind` must match the draft's canonical payload
(`initial | amendment | correction | retraction`); the adapter throws
loudly without it.

**Publisher signing:** `submitAnchor` needs a `SignFn`. In production this
is `PUBLISHER_SIGNER_REFERENCE` (vault/KMS reference). If signing is
unavailable the job fails with `PublisherSigningUnavailableError` — this is
a *configuration* failure, not a retryable chain failure; do not hammer
retry, fix the signer wiring. `PUBLISHER_KEYPAIR_PATH` is dev-only and is
refused in production unless `PUBLISHER_ALLOW_FILE_SIGNER=1`.

## 2. Queue dead-letter handling

Queues (BullMQ, `apps/worker/src/queues.ts`): `publish`, `anchor-receipt`,
`research-*`, `maintenance`, `notifications`.

- **Transient failures** (5xx, timeouts, RPC blips): exponential backoff
  with jitter, then requeue. Do nothing unless the rate spikes.
- **Permanent failures** (`PermanentError`: `draft-not-found`,
  `canonical-digest-mismatch`, `research-run-not-found`, structural
  validation failures): moved to the dead-letter queue immediately, **no
  retry**. These need a human:
  1. Read the dead-letter reason.
  2. `draft-not-found` / `canonical-digest-mismatch` → data problem in the
     publish flow; do not requeue blindly — fix the draft first.
  3. Citation-gate / structural failures on research drafts → route to an
     editor; the draft is in `research_drafts` for inspection.
- **Poison jobs** (same job dead-lettering repeatedly after manual requeue):
  quarantine the job key (`jobKeys.*`), investigate the payload, fix the
  producer.

**Queue depth alerts:** sustained growth in `publish` or `anchor-receipt`
means the worker is down or Redis is unreachable — check `/health/ready`
on the worker host and Redis connectivity before touching job data.

## 3. Provider outage playbook

### Model provider down (`MODEL_PROVIDER_KEY` invalid / 5xx / timeout)

- Research steps return `{ providerUnavailable: true }`; runs go to
  `awaiting_provider`. **No data is fabricated** — drafts are not written,
  facts are not extracted.
- Public reads of published content are unaffected (reads never need the
  model key).
- Recovery: fix the key/endpoint; runs in `awaiting_provider` are picked
  up by the research scheduler on the next tick. No manual requeue needed
  unless the run was marked `failed`.

### Search providers down

- `runDiscoveryStep` returns `{ providerUnavailable: true }` when *all*
  providers fail health; partial failures are recorded as coverage gaps
  on the run (`steps` log) and discovery continues with the survivors.
- Coverage gaps are honest metadata on the draft — editors see what wasn't
  searched.

### Solana RPC down (primary + fallback)

- `submitAnchor` throws after `withRpcFallback` exhausts URLs → job retries
  with backoff, receipt stays `submitted`/`pending`.
- `getReceiptAccount` / `getSignatureStatus` failures are transient —
  the reconciler keeps the last known DB state and retries.
- Do **not** mark receipts `failed` manually during an RPC outage; let the
  reconciler converge when the RPC recovers.

### Object storage down

- Publish fails at the bundle-upload step (`storage.putObject` throws);
  the draft stays `approved`, nothing is marked published. Safe to retry
  the publish job after recovery — the object key is content-addressed,
  so a retry overwrites identical bytes.
- `createStorageAdapter()` returns `null` when unconfigured: storage-backed
  steps fail loudly at call time. This is intentional — the alternative
  (pretending to store) would corrupt the publish pipeline.

## 4. Daily checks

1. `/health/ready` on API and worker → `ready` (investigate `degraded`).
2. Dead-letter queue depth → 0 (or triaged).
3. `publication_receipts`: no `submitted` older than 30 min.
4. Research runs: no `failed` without an editor-assigned follow-up.
5. Disk: Postgres + Redis growth within expected bounds.
