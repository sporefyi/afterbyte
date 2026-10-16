# Rollback & restore runbook

## 1. Migration discipline (expand / contract)

The database is the hardest thing to roll back, so schema changes follow
expand/contract:

1. **Expand release N:** only additive changes — new tables, new nullable
   columns, new indexes (`CREATE INDEX CONCURRENTLY` on large tables).
   Old code keeps working; new code must tolerate the old schema.
2. **Migrate data** (backfills) as idempotent worker jobs, not in the
   migration transaction.
3. **Contract release N+1 (or later):** only after every running instance
   is on release N and no code reads the old shape — drop columns/tables.

What this buys: any release can be rolled back by redeploying the previous
container image, because the schema is always a superset of what the old
code needs.

Emergency rule: never run a destructive migration under time pressure. If a
bad expand already shipped, roll the *code* back first (schema is additive,
old code still works), then plan the contract calmly.

## 2. Point-in-time recovery (Postgres)

Production Postgres must have PITR (WAL archiving / managed point-in-time
restore). Before any migration, note the current time as the restore point.

Restore procedure:

1. Stop the API and worker (no writes during restore).
2. Restore to the noted point into a **new** instance; keep the damaged
   instance untouched until the restore is verified.
3. Point `DATABASE_URL` at the restored instance.
4. Run `pnpm -r test` with `DATABASE_URL` set (DB integration tests execute).
5. Restart worker first, then API. Verify `/health/ready` → `ready`.

RPO/RTO targets are set per environment by the operator; the mechanism
above is what makes them achievable.

## 3. Object storage versioning

Both buckets (`OBJECT_STORAGE_BUCKET_PUBLIC`, `OBJECT_STORAGE_BUCKET_PRIVATE`)
must have **versioning enabled**:

- Canonical bundles (`canonical/<hash>.json`) are content-addressed —
  overwrites are identical bytes, so versioning is a safety net, not a
  correctness requirement.
- Source snapshots and quarantined uploads are mutable — versioning is the
  only way to recover an overwritten or wrongly deleted object.
- Lifecycle: keep non-current versions 30 days, then expire.

Restore of a single object: list versions, promote the last-known-good
version. The worker's `StorageClient` addresses objects by key; a restore
is a copy-overwrite of the same key (canonical bundles: verify the hash
after copy).

## 4. Chain reconciliation after a restore

A database restore can rewind the worker's view of on-chain state. Receipts
are the source of truth **on chain**; the DB is a cache. After any restore:

1. Run the receipt reconciler's recheck sweep
   (`recheckReceipt` over all `publication_receipts` with status
   `pending | submitted | confirmed`).
2. For each receipt the DB thinks is unanchored, the reconciler re-derives
   the receipt address (`deriveReceiptAddress`) and reads the on-chain
   account (`getReceiptAccount`):
   - Account exists and `finalized` → mark finalized (adopt chain state).
   - Account exists, not finalized → resume confirmation tracking.
   - No account → the anchor never landed; re-queue `anchor-receipt`
     (idempotent via `jobKeys.anchorReceipt(subjectId, versionNumber)`).
3. Verify no `submitted` receipt is left pointing at a signature the chain
   never saw: `getSignatureStatus` on each recorded signature; unknown
   signatures go back to `pending` for re-anchor.
4. Cross-check the `previousPayloadHash` chain: for each subject, versions
   must form an unbroken sequence. A gap means a version was anchored but
   its DB row was lost — re-derive from chain (`getReceiptAccount` per
   version) and backfill the row before any new publish for that subject.

**Never re-anchor a version that is already finalized on chain.** The
reconciler's derive-then-read step exists precisely to prevent double
anchoring after a restore.

## 5. What is NOT restored from backup

- Redis queues: BullMQ jobs are re-derivable. After a restore, the worker
  re-enqueues from the outbox (`receipt.anchor.requested`,
  `research.*.requested`) — the outbox table is in Postgres and *is*
  restored.
- Derived read models: rebuilt by the worker's refresh jobs.
- Local `notYet`/unconfigured capabilities: nothing to restore; they fail
  loudly until configured.
