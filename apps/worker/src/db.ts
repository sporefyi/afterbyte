/**
 * Database port — the worker's storage contract.
 *
 * The durable schema is owned by @afterbyte/database (not yet landed). Until
 * it exists, these interfaces are the source of truth the database lane builds
 * against; the required table shapes are documented in src/schema.sql and the
 * production implementation lives in src/pg.ts.
 *
 * Design rules (brief §8):
 * - A domain mutation and its outbox events commit in ONE transaction.
 * - Consumers record event handling transactionally (dedup).
 * - Business dedup is the `job_records` table, NOT BullMQ job rows — queue
 *   job removal must never erase business deduplication.
 */

import type {
  JobRecord,
  JobRecordStatus,
  Lease,
  OutboxEvent,
  OutboxStatus,
  PublicationReceipt,
  PublishedSubjectRow,
  ReadModel,
  ReceiptStatus,
  DossierVersionDraft,
  TxAttempt,
} from './types.js';

/** Re-export domain types so consumers import the port + types from one place. */
export type {
  JobRecord,
  JobRecordStatus,
  Lease,
  OutboxEvent,
  PublicationReceipt,
  PublishedSubjectRow,
  ReadModel,
  ReceiptStatus,
  DossierVersionDraft,
  TxAttempt,
};

/** Transaction-scoped handle passed to every mutating operation. */
export interface Tx {
  // Marker interface; PgTx wraps a pg client, MemTx wraps the in-memory store.
  readonly __brand: 'Tx';
}

export interface NewOutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Outbox + job-record + handled-event operations. */
export interface OutboxStore {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;

  insertOutboxEvents(tx: Tx, events: NewOutboxEvent[]): Promise<OutboxEvent[]>;
  /**
   * Claim a batch of due pending events for dispatch.
   * Production SQL: SELECT ... FOR UPDATE SKIP LOCKED, then mark dispatched.
   */
  claimOutboxBatch(tx: Tx, limit: number, now: string): Promise<OutboxEvent[]>;
  markOutboxDispatched(tx: Tx, id: string, jobId: string, now: string): Promise<void>;
  markOutboxDone(tx: Tx, id: string, now: string): Promise<void>;
  markOutboxFailed(tx: Tx, id: string, error: string, nextAttemptAt: string): Promise<void>;
  /** Events stuck in `dispatched` with no ack — redeliver candidates. */
  listStuckDispatched(tx: Tx, olderThan: string, limit: number): Promise<OutboxEvent[]>;
  resetStuckToPending(tx: Tx, ids: string[], now: string): Promise<void>;
  countPendingOutbox(tx: Tx): Promise<number>;

  /** Transactional consumer dedup (at-least-once delivery). */
  hasHandledEvent(tx: Tx, eventId: string, consumer: string): Promise<boolean>;
  recordHandledEvent(tx: Tx, eventId: string, consumer: string, now: string): Promise<void>;

  /**
   * Durable public-event log (brief §14 SSE). The dispatcher writes public
   * events here instead of enqueueing BullMQ jobs; the API lane replays them.
   */
  insertPublicEvent(
    tx: Tx,
    event: { eventType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: string },
  ): Promise<void>;

  /**
   * Business dedup root: insert the job record when absent, no-op when present.
   * Deduplication decisions read the record's STATUS (see handler.ts) — the
   * mere existence of a key never skips work, so BullMQ retries of the same
   * job still re-run idempotent work.
   */
  ensureJobRecord(tx: Tx, jobKey: string, queue: string, now: string): Promise<void>;
  getJobRecord(tx: Tx, jobKey: string): Promise<JobRecord | null>;
  setJobRecordStatus(
    tx: Tx,
    jobKey: string,
    status: JobRecordStatus,
    patch?: { attempts?: number; lastError?: string | null; heartbeatAt?: string | null },
  ): Promise<void>;
  heartbeatJob(tx: Tx, jobKey: string, now: string): Promise<void>;
  cancelJob(tx: Tx, jobKey: string): Promise<void>;
  /** Jobs stuck `running` with an old heartbeat — crash-recovery candidates. */
  listStrandedJobs(tx: Tx, olderThan: string, limit: number): Promise<JobRecord[]>;
}

/** Lease operations for long steps. */
export interface LeaseStore {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Returns the lease when acquired, null when held by someone else. */
  acquireLease(tx: Tx, leaseKey: string, owner: string, ttlMs: number, now: string): Promise<Lease | null>;
  heartbeatLease(tx: Tx, leaseKey: string, owner: string, ttlMs: number, now: string): Promise<boolean>;
  releaseLease(tx: Tx, leaseKey: string, owner: string): Promise<void>;
  getLease(tx: Tx, leaseKey: string): Promise<Lease | null>;
}

/** Read-model + published-data reads for refresh-read-models. */
export interface ReadModelStore {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Published data only — the query backing this MUST exclude rejected/unpublished. */
  listPublishedSubjects(tx: Tx): Promise<PublishedSubjectRow[]>;
  upsertReadModel(tx: Tx, model: Omit<ReadModel, 'updatedAt'>): Promise<void>;
  getReadModel(tx: Tx, key: string): Promise<ReadModel | null>;
  /** Monotonic source revision (e.g. max updated_at / event sequence). */
  currentSourceRevision(tx: Tx): Promise<string>;
}

/** Publish-flow persistence. */
export interface PublishStore {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The ONE transaction: immutable version + current pointer + outbox events. */
  commitPublication(
    tx: Tx,
    args: {
      draft: DossierVersionDraft;
      canonicalBytes: Uint8Array;
      payloadHash: string;
      objectKey: string;
      publishedAt: string;
      outboxEvents: NewOutboxEvent[];
    },
  ): Promise<void>;
  getDraftForPublish(tx: Tx, draftId: string): Promise<DossierVersionDraft | null>;
  versionExists(tx: Tx, subjectId: string, versionNumber: number): Promise<boolean>;
}

/** Receipt + tx-attempt persistence for the reconciler. */
export interface ReceiptStore {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  getReceipt(tx: Tx, subjectId: string, versionNumber: number): Promise<PublicationReceipt | null>;
  upsertReceipt(tx: Tx, receipt: PublicationReceipt): Promise<void>;
  /** Persist BEFORE submission — never after. */
  recordTxAttempt(
    tx: Tx,
    attempt: Omit<TxAttempt, 'id' | 'createdAt'>,
  ): Promise<TxAttempt>;
  updateTxAttempt(tx: Tx, id: string, patch: { status: ReceiptStatus; slot?: number | null; error?: string | null; signature?: string }): Promise<void>;
  listAttemptsForReceipt(tx: Tx, subjectId: string, versionNumber: number): Promise<TxAttempt[]>;
  /** Receipts needing a recheck (submitted/confirmed, or stale pending). */
  listReceiptsNeedingRecheck(tx: Tx, limit: number): Promise<PublicationReceipt[]>;
}

/** Worker heartbeat + maintenance bookkeeping. */
export interface OpsStore {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  upsertWorkerHeartbeat(
    tx: Tx,
    args: { workerId: string; queues: string[]; startedAt: string; now: string; stats?: Record<string, unknown> },
  ): Promise<void>;
  pruneHandledEvents(tx: Tx, olderThan: string): Promise<number>;
  pruneDoneOutbox(tx: Tx, olderThan: string): Promise<number>;
}

export type { OutboxStatus };
