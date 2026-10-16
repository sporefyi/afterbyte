/**
 * Shared domain types for the AFTERBYTE worker.
 *
 * These are the worker's own structural contracts. Persistent storage is owned
 * by @afterbyte/database (not yet landed); the SQL table shapes the worker
 * expects are documented in src/schema.sql and implemented by the PgStore in
 * src/pg.ts. Until then this file + db.ts are the source of truth the database
 * lane builds against.
 */

/** ISO-8601 UTC timestamp with seconds precision (ADR-0002 product rule). */
export type IsoUtc = string;

/** Outbox event lifecycle. */
export type OutboxStatus = 'pending' | 'dispatched' | 'done' | 'failed';

export interface OutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  /** Domain payload — IDs and schema versions only, never whole private articles. */
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: IsoUtc;
  dispatchedAt: IsoUtc | null;
  jobId: string | null;
  lastError: string | null;
  createdAt: IsoUtc;
}

/** Business-level job record — the durable dedup that survives queue removal. */
export type JobRecordStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface JobRecord {
  jobKey: string;
  queue: string;
  status: JobRecordStatus;
  attempts: number;
  heartbeatAt: IsoUtc | null;
  cancelled: boolean;
  lastError: string | null;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
}

/** Receipt lifecycle — honest states only, no fabrication. */
export type ReceiptStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'finalized'
  | 'failed'
  | 'unavailable';

export interface TxAttempt {
  id: string;
  subjectId: string;
  versionNumber: number;
  signature: string;
  slot: number | null;
  status: ReceiptStatus;
  rpcUrl: string;
  error: string | null;
  createdAt: IsoUtc;
}

export interface PublicationReceipt {
  subjectId: string;
  versionNumber: number;
  payloadHash: string;
  /** On-chain publication kind label; null when not yet known. */
  publicationKind: string | null;
  status: ReceiptStatus;
  signature: string | null;
  slot: number | null;
  finalizedAt: IsoUtc | null;
  updatedAt: IsoUtc;
}

/** Lease row for long-running steps. */
export interface Lease {
  leaseKey: string;
  owner: string;
  acquiredAt: IsoUtc;
  expiresAt: IsoUtc;
  heartbeatAt: IsoUtc;
}

/** Materialized read-model row. */
export interface ReadModel {
  key: string;
  payload: Record<string, unknown>;
  asOf: IsoUtc;
  sourceRevision: string;
  updatedAt: IsoUtc;
}

/** Row shapes the worker reads for read-model computation (published data only). */
export interface PublishedSubjectRow {
  subjectId: string;
  /** Current reviewed lifecycle status, e.g. 'active' | 'dormant' | 'discontinued'. */
  lifecycleStatus: string;
  /** True when a retraction version is the current version. */
  isRetracted: boolean;
  currentVersionNumber: number | null;
  versionsWithFinalizedReceipts: number;
}

/** Minimal dossier version info needed by the publish flow. */
export interface DossierVersionDraft {
  subjectId: string;
  versionNumber: number;
  draftId: string;
  previousPayloadHash: string;
  /** Canonical payload fields assembled by the API/editorial lane (ADR-0002). */
  payload: Record<string, unknown>;
}
