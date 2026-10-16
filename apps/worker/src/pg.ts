/**
 * Production Postgres implementation of the db.ts ports, using `pg` Pool.
 *
 * SQL matches src/schema.sql exactly. Owned by the worker lane until
 * @afterbyte/database lands, at which point this file should delegate to the
 * database package's Drizzle client while keeping the same port interfaces.
 */
import { Pool, type PoolClient } from 'pg';
import type {
  JobRecord,
  JobRecordStatus,
  Lease,
  NewOutboxEvent,
  OutboxStore,
  LeaseStore,
  OpsStore,
  PublicationReceipt,
  PublishedSubjectRow,
  ReadModel,
  ReadModelStore,
  ReceiptStore,
  PublishStore,
  Tx,
  TxAttempt,
  DossierVersionDraft,
  ReceiptStatus,
} from './db.js';
import type { OutboxEvent } from './types.js';

class PgTx implements Tx {
  readonly __brand = 'Tx' as const;
  constructor(readonly client: PoolClient) {}
}

function txClient(tx: Tx): PoolClient {
  return (tx as PgTx).client;
}

async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(new PgTx(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function toOutboxEvent(r: Record<string, unknown>): OutboxEvent {
  return {
    id: r.id as string,
    aggregateType: r.aggregate_type as string,
    aggregateId: r.aggregate_id as string,
    eventType: r.event_type as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as OutboxEvent['status'],
    attempts: r.attempts as number,
    nextAttemptAt: (r.next_attempt_at as Date).toISOString(),
    dispatchedAt: r.dispatched_at ? (r.dispatched_at as Date).toISOString() : null,
    jobId: (r.job_id as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

function toJobRecord(r: Record<string, unknown>): JobRecord {
  return {
    jobKey: r.job_key as string,
    queue: r.queue as string,
    status: r.status as JobRecordStatus,
    attempts: r.attempts as number,
    heartbeatAt: r.heartbeat_at ? (r.heartbeat_at as Date).toISOString() : null,
    cancelled: r.cancelled as boolean,
    lastError: (r.last_error as string) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}

export class PgOutboxStore implements OutboxStore {
  constructor(private readonly pool: Pool) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  async insertOutboxEvents(tx: Tx, events: NewOutboxEvent[]): Promise<OutboxEvent[]> {
    if (events.length === 0) return [];
    const c = txClient(tx);
    const values: unknown[] = [];
    const rows = events.map((e, i) => {
      const o = i * 4;
      values.push(e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(e.payload));
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}::jsonb)`;
    });
    const res = await c.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ${rows.join(', ')} RETURNING *`,
      values,
    );
    return res.rows.map(toOutboxEvent);
  }

  async claimOutboxBatch(tx: Tx, limit: number, now: string): Promise<OutboxEvent[]> {
    const c = txClient(tx);
    // Claim + mark dispatched atomically; SKIP LOCKED keeps dispatchers from blocking.
    const res = await c.query(
      `UPDATE outbox_events
       SET status = 'dispatched', dispatched_at = $2::timestamptz, attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE status = 'pending' AND next_attempt_at <= $2::timestamptz
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit, now],
    );
    return res.rows.map(toOutboxEvent);
  }

  async markOutboxDispatched(tx: Tx, id: string, jobId: string, now: string): Promise<void> {
    await txClient(tx).query(
      `UPDATE outbox_events SET status = 'dispatched', dispatched_at = $2::timestamptz, job_id = $3
       WHERE id = $1::uuid`,
      [id, now, jobId],
    );
  }

  async markOutboxDone(tx: Tx, id: string, now: string): Promise<void> {
    await txClient(tx).query(
      `UPDATE outbox_events SET status = 'done' WHERE id = $1::uuid AND status <> 'done'`,
      [id],
    );
  }

  async markOutboxFailed(tx: Tx, id: string, error: string, nextAttemptAt: string): Promise<void> {
    await txClient(tx).query(
      `UPDATE outbox_events SET status = 'failed', last_error = $2, next_attempt_at = $3::timestamptz
       WHERE id = $1::uuid`,
      [id, error, nextAttemptAt],
    );
  }

  async listStuckDispatched(tx: Tx, olderThan: string, limit: number): Promise<OutboxEvent[]> {
    const res = await txClient(tx).query(
      `SELECT * FROM outbox_events
       WHERE status = 'dispatched' AND dispatched_at <= $1::timestamptz
       ORDER BY dispatched_at ASC LIMIT $2`,
      [olderThan, limit],
    );
    return res.rows.map(toOutboxEvent);
  }

  async resetStuckToPending(tx: Tx, ids: string[], now: string): Promise<void> {
    if (ids.length === 0) return;
    await txClient(tx).query(
      `UPDATE outbox_events
       SET status = 'pending', next_attempt_at = $2::timestamptz, dispatched_at = NULL
       WHERE id = ANY($1::uuid[]) AND status = 'dispatched'`,
      [ids, now],
    );
  }

  async countPendingOutbox(tx: Tx): Promise<number> {
    const res = await txClient(tx).query(
      `SELECT COUNT(*)::int AS n FROM outbox_events WHERE status = 'pending'`,
    );
    return res.rows[0].n as number;
  }

  async hasHandledEvent(tx: Tx, eventId: string, consumer: string): Promise<boolean> {
    const res = await txClient(tx).query(
      `SELECT 1 FROM handled_events WHERE event_id = $1::uuid AND consumer = $2`,
      [eventId, consumer],
    );
    return res.rowCount === 1;
  }

  async recordHandledEvent(tx: Tx, eventId: string, consumer: string): Promise<void> {
    await txClient(tx).query(
      `INSERT INTO handled_events (event_id, consumer) VALUES ($1::uuid, $2)
       ON CONFLICT DO NOTHING`,
      [eventId, consumer],
    );
  }

  async insertPublicEvent(
    tx: Tx,
    event: { eventType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: string },
  ): Promise<void> {
    await txClient(tx).query(
      `INSERT INTO public_events (event_type, aggregate_id, payload, occurred_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz)`,
      [event.eventType, event.aggregateId, JSON.stringify(event.payload), event.occurredAt],
    );
  }

  async ensureJobRecord(tx: Tx, jobKey: string, queue: string, now: string): Promise<void> {
    await txClient(tx).query(
      `INSERT INTO job_records (job_key, queue, created_at, updated_at)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz)
       ON CONFLICT (job_key) DO NOTHING`,
      [jobKey, queue, now],
    );
  }

  async getJobRecord(tx: Tx, jobKey: string): Promise<JobRecord | null> {
    const res = await txClient(tx).query(`SELECT * FROM job_records WHERE job_key = $1`, [jobKey]);
    return res.rows.length > 0 ? toJobRecord(res.rows[0]) : null;
  }

  async setJobRecordStatus(
    tx: Tx,
    jobKey: string,
    status: JobRecordStatus,
    patch: { attempts?: number; lastError?: string | null; heartbeatAt?: string | null } = {},
  ): Promise<void> {
    await txClient(tx).query(
      `UPDATE job_records
       SET status = $2,
           attempts = COALESCE($3, attempts),
           last_error = COALESCE($4, last_error),
           heartbeat_at = COALESCE($5::timestamptz, heartbeat_at),
           updated_at = now()
       WHERE job_key = $1`,
      [jobKey, status, patch.attempts ?? null, patch.lastError ?? null, patch.heartbeatAt ?? null],
    );
  }

  async heartbeatJob(tx: Tx, jobKey: string, now: string): Promise<void> {
    await txClient(tx).query(
      `UPDATE job_records SET heartbeat_at = $2::timestamptz, updated_at = now()
       WHERE job_key = $1`,
      [jobKey, now],
    );
  }

  async cancelJob(tx: Tx, jobKey: string): Promise<void> {
    await txClient(tx).query(
      `UPDATE job_records SET cancelled = TRUE, updated_at = now() WHERE job_key = $1`,
      [jobKey],
    );
  }

  async listStrandedJobs(tx: Tx, olderThan: string, limit: number): Promise<JobRecord[]> {
    const res = await txClient(tx).query(
      `SELECT * FROM job_records
       WHERE status = 'running' AND cancelled = FALSE
         AND COALESCE(heartbeat_at, updated_at) <= $1::timestamptz
       ORDER BY updated_at ASC LIMIT $2`,
      [olderThan, limit],
    );
    return res.rows.map(toJobRecord);
  }
}

export class PgLeaseStore implements LeaseStore {
  constructor(private readonly pool: Pool) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  async acquireLease(
    tx: Tx,
    leaseKey: string,
    owner: string,
    ttlMs: number,
    now: string,
  ): Promise<Lease | null> {
    const c = txClient(tx);
    const res = await c.query(
      `INSERT INTO worker_leases (lease_key, owner, expires_at, heartbeat_at)
       VALUES ($1, $2, $3::timestamptz + make_interval(secs => $4 / 1000.0), $3::timestamptz)
       ON CONFLICT (lease_key) DO UPDATE
       SET owner = EXCLUDED.owner,
           acquired_at = $3::timestamptz,
           expires_at = $3::timestamptz + make_interval(secs => $4 / 1000.0),
           heartbeat_at = $3::timestamptz
       WHERE worker_leases.expires_at <= $3::timestamptz OR worker_leases.owner = EXCLUDED.owner
       RETURNING *`,
      [leaseKey, owner, now, ttlMs],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      leaseKey: r.lease_key as string,
      owner: r.owner as string,
      acquiredAt: (r.acquired_at as Date).toISOString(),
      expiresAt: (r.expires_at as Date).toISOString(),
      heartbeatAt: (r.heartbeat_at as Date).toISOString(),
    };
  }

  async heartbeatLease(
    tx: Tx,
    leaseKey: string,
    owner: string,
    ttlMs: number,
    now: string,
  ): Promise<boolean> {
    const res = await txClient(tx).query(
      `UPDATE worker_leases
       SET heartbeat_at = $3::timestamptz,
           expires_at = $3::timestamptz + make_interval(secs => $4 / 1000.0)
       WHERE lease_key = $1 AND owner = $2`,
      [leaseKey, owner, now, ttlMs],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async releaseLease(tx: Tx, leaseKey: string, owner: string): Promise<void> {
    await txClient(tx).query(
      `DELETE FROM worker_leases WHERE lease_key = $1 AND owner = $2`,
      [leaseKey, owner],
    );
  }

  async getLease(tx: Tx, leaseKey: string): Promise<Lease | null> {
    const res = await txClient(tx).query(
      `SELECT * FROM worker_leases WHERE lease_key = $1`,
      [leaseKey],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      leaseKey: r.lease_key as string,
      owner: r.owner as string,
      acquiredAt: (r.acquired_at as Date).toISOString(),
      expiresAt: (r.expires_at as Date).toISOString(),
      heartbeatAt: (r.heartbeat_at as Date).toISOString(),
    };
  }
}

export class PgReadModelStore implements ReadModelStore {
  constructor(private readonly pool: Pool) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  /**
   * Published data only. The dossier tables behind this query are owned by
   * the database/editorial lanes; the contract is: one row per subject that
   * has a CURRENT published version, excluding rejected/unpublished and
   * flagging retracted currents. The worker additionally filters defensively.
   */
  async listPublishedSubjects(tx: Tx): Promise<PublishedSubjectRow[]> {
    const res = await txClient(tx).query(
      `SELECT s.id AS subject_id,
              s.lifecycle_status AS lifecycle_status,
              (v.publication_kind = 'retraction') AS is_retracted,
              v.version_number AS current_version_number,
              COALESCE((
                SELECT COUNT(*) FROM publication_receipts pr
                WHERE pr.subject_id = s.id AND pr.status = 'finalized'
              ), 0)::int AS versions_with_finalized_receipts
       FROM subjects s
       JOIN dossier_versions v
         ON v.subject_id = s.id AND v.version_number = s.current_version
       WHERE s.current_version IS NOT NULL`,
    );
    return res.rows.map((r) => ({
      subjectId: r.subject_id as string,
      lifecycleStatus: r.lifecycle_status as string,
      isRetracted: r.is_retracted as boolean,
      currentVersionNumber: (r.current_version_number as number) ?? null,
      versionsWithFinalizedReceipts: r.versions_with_finalized_receipts as number,
    }));
  }

  async upsertReadModel(tx: Tx, model: Omit<ReadModel, 'updatedAt'>): Promise<void> {
    await txClient(tx).query(
      `INSERT INTO read_models (key, payload, as_of, source_revision)
       VALUES ($1, $2::jsonb, $3::timestamptz, $4)
       ON CONFLICT (key) DO UPDATE
       SET payload = EXCLUDED.payload,
           as_of = EXCLUDED.as_of,
           source_revision = EXCLUDED.source_revision,
           updated_at = now()`,
      [model.key, JSON.stringify(model.payload), model.asOf, model.sourceRevision],
    );
  }

  async getReadModel(tx: Tx, key: string): Promise<ReadModel | null> {
    const res = await txClient(tx).query(`SELECT * FROM read_models WHERE key = $1`, [key]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      key: r.key as string,
      payload: (r.payload as Record<string, unknown>) ?? {},
      asOf: (r.as_of as Date).toISOString(),
      sourceRevision: r.source_revision as string,
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async currentSourceRevision(tx: Tx): Promise<string> {
    // Monotonic revision: latest outbox event sequence surrogate.
    const res = await txClient(tx).query(
      `SELECT COALESCE(MAX(created_at), now())::text AS rev FROM outbox_events`,
    );
    return res.rows[0].rev as string;
  }
}

export class PgPublishStore implements PublishStore {
  constructor(private readonly pool: Pool) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  /**
   * THE publication commit (brief §9): immutable version row + current-version
   * pointer + receipt outbox events in ONE transaction. The DB commit is the
   * publication authority; object storage + read models follow asynchronously.
   */
  async commitPublication(
    tx: Tx,
    args: {
      draft: DossierVersionDraft;
      canonicalBytes: Uint8Array;
      payloadHash: string;
      objectKey: string;
      publishedAt: string;
      outboxEvents: import('./db.js').NewOutboxEvent[];
    },
  ): Promise<void> {
    const c = txClient(tx);
    const { draft } = args;
    await c.query(
      `INSERT INTO dossier_versions
         (subject_id, version_number, payload_hash, object_key, published_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [draft.subjectId, draft.versionNumber, args.payloadHash, args.objectKey, args.publishedAt],
    );
    await c.query(
      `INSERT INTO dossier_current_versions (subject_id, current_version, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (subject_id) DO UPDATE
       SET current_version = EXCLUDED.current_version, updated_at = now()`,
      [draft.subjectId, draft.versionNumber],
    );
    if (args.outboxEvents.length > 0) {
      const values: unknown[] = [];
      const rows = args.outboxEvents.map((e, i) => {
        const o = i * 4;
        values.push(e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(e.payload));
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}::jsonb)`;
      });
      await c.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ${rows.join(', ')}`,
        values,
      );
    }
  }

  async getDraftForPublish(tx: Tx, draftId: string): Promise<DossierVersionDraft | null> {
    // Drafts are owned by the editorial lane; shape contract documented here
    // until the database package exposes a typed accessor.
    const res = await txClient(tx).query(
      `SELECT id, subject_id, version_number, previous_payload_hash, payload
       FROM dossier_drafts WHERE id = $1::uuid`,
      [draftId],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      subjectId: r.subject_id as string,
      versionNumber: r.version_number as number,
      draftId: r.id as string,
      previousPayloadHash: r.previous_payload_hash as string,
      payload: (r.payload as Record<string, unknown>) ?? {},
    };
  }

  async versionExists(tx: Tx, subjectId: string, versionNumber: number): Promise<boolean> {
    const res = await txClient(tx).query(
      `SELECT 1 FROM dossier_versions WHERE subject_id = $1 AND version_number = $2`,
      [subjectId, versionNumber],
    );
    return (res.rowCount ?? 0) === 1;
  }
}

function toReceipt(r: Record<string, unknown>): PublicationReceipt {
  return {
    subjectId: r.subject_id as string,
    versionNumber: r.version_number as number,
    payloadHash: r.payload_hash as string,
    status: r.status as ReceiptStatus,
    signature: (r.signature as string) ?? null,
    slot: r.slot != null ? Number(r.slot) : null,
    finalizedAt: r.finalized_at ? (r.finalized_at as Date).toISOString() : null,
    updatedAt: (r.updated_at as Date).toISOString(),
    publicationKind: (r.publication_kind as string) ?? null,
  };
}

export class PgReceiptStore implements ReceiptStore {
  constructor(private readonly pool: Pool) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  async getReceipt(tx: Tx, subjectId: string, versionNumber: number): Promise<PublicationReceipt | null> {
    const res = await txClient(tx).query(
      `SELECT * FROM publication_receipts WHERE subject_id = $1 AND version_number = $2`,
      [subjectId, versionNumber],
    );
    return res.rows.length > 0 ? toReceipt(res.rows[0]) : null;
  }

  async upsertReceipt(tx: Tx, receipt: PublicationReceipt): Promise<void> {
    await txClient(tx).query(
      `INSERT INTO publication_receipts
         (subject_id, version_number, payload_hash, publication_kind, status, signature, slot, finalized_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, now())
       ON CONFLICT (subject_id, version_number) DO UPDATE
       SET payload_hash = EXCLUDED.payload_hash,
           publication_kind = COALESCE(EXCLUDED.publication_kind, publication_receipts.publication_kind),
           status = EXCLUDED.status,
           signature = EXCLUDED.signature,
           slot = EXCLUDED.slot,
           finalized_at = EXCLUDED.finalized_at,
           updated_at = now()`,
      [
        receipt.subjectId,
        receipt.versionNumber,
        receipt.payloadHash,
        receipt.publicationKind,
        receipt.status,
        receipt.signature,
        receipt.slot,
        receipt.finalizedAt,
      ],
    );
  }

  async recordTxAttempt(
    tx: Tx,
    attempt: Omit<TxAttempt, 'id' | 'createdAt'>,
  ): Promise<TxAttempt> {
    const res = await txClient(tx).query(
      `INSERT INTO tx_attempts
         (subject_id, version_number, signature, slot, status, rpc_url, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        attempt.subjectId,
        attempt.versionNumber,
        attempt.signature,
        attempt.slot,
        attempt.status,
        attempt.rpcUrl,
        attempt.error,
      ],
    );
    const r = res.rows[0];
    return {
      id: r.id as string,
      subjectId: r.subject_id as string,
      versionNumber: r.version_number as number,
      signature: r.signature as string,
      slot: r.slot != null ? Number(r.slot) : null,
      status: r.status as ReceiptStatus,
      rpcUrl: r.rpc_url as string,
      error: (r.error as string) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
    };
  }

  async updateTxAttempt(
    tx: Tx,
    id: string,
    patch: { status: ReceiptStatus; slot?: number | null; error?: string | null; signature?: string },
  ): Promise<void> {
    await txClient(tx).query(
      `UPDATE tx_attempts SET status = $2,
        slot = COALESCE($3, slot),
        error = COALESCE($4, error),
        signature = CASE WHEN $5 IS NULL OR $5 = '' THEN signature ELSE $5 END
       WHERE id = $1::uuid`,
      [id, patch.status, patch.slot ?? null, patch.error ?? null, patch.signature ?? null],
    );
  }

  async listAttemptsForReceipt(
    tx: Tx,
    subjectId: string,
    versionNumber: number,
  ): Promise<TxAttempt[]> {
    const res = await txClient(tx).query(
      `SELECT * FROM tx_attempts
       WHERE subject_id = $1 AND version_number = $2
       ORDER BY created_at DESC`,
      [subjectId, versionNumber],
    );
    return res.rows.map((r) => ({
      id: r.id as string,
      subjectId: r.subject_id as string,
      versionNumber: r.version_number as number,
      signature: r.signature as string,
      slot: r.slot != null ? Number(r.slot) : null,
      status: r.status as ReceiptStatus,
      rpcUrl: r.rpc_url as string,
      error: (r.error as string) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
    }));
  }

  async listReceiptsNeedingRecheck(tx: Tx, limit: number): Promise<PublicationReceipt[]> {
    const res = await txClient(tx).query(
      `SELECT * FROM publication_receipts
       WHERE status IN ('pending', 'submitted', 'confirmed')
       ORDER BY updated_at ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map(toReceipt);
  }
}

export class PgOpsStore implements OpsStore {
  constructor(private readonly pool: Pool) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  async upsertWorkerHeartbeat(
    tx: Tx,
    args: { workerId: string; queues: string[]; startedAt: string; now: string; stats?: Record<string, unknown> },
  ): Promise<void> {
    await txClient(tx).query(
      `INSERT INTO worker_heartbeats (worker_id, queues, started_at, updated_at, stats)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::jsonb)
       ON CONFLICT (worker_id) DO UPDATE
       SET queues = EXCLUDED.queues, updated_at = EXCLUDED.updated_at, stats = EXCLUDED.stats`,
      [args.workerId, args.queues, args.startedAt, args.now, JSON.stringify(args.stats ?? {})],
    );
  }

  async pruneHandledEvents(tx: Tx, olderThan: string): Promise<number> {
    const res = await txClient(tx).query(
      `DELETE FROM handled_events WHERE handled_at <= $1::timestamptz`,
      [olderThan],
    );
    return res.rowCount ?? 0;
  }

  async pruneDoneOutbox(tx: Tx, olderThan: string): Promise<number> {
    const res = await txClient(tx).query(
      `DELETE FROM outbox_events
       WHERE status = 'done' AND created_at <= $1::timestamptz`,
      [olderThan],
    );
    return res.rowCount ?? 0;
  }
}

/** All production stores sharing one pool. */
export interface PgStores {
  pool: Pool;
  outbox: PgOutboxStore;
  leases: PgLeaseStore;
  readmodels: PgReadModelStore;
  publish: PgPublishStore;
  receipts: PgReceiptStore;
  ops: PgOpsStore;
}

export function createPgStores(databaseUrl: string): PgStores {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', err: String(err) }));
  });
  return {
    pool,
    outbox: new PgOutboxStore(pool),
    leases: new PgLeaseStore(pool),
    readmodels: new PgReadModelStore(pool),
    publish: new PgPublishStore(pool),
    receipts: new PgReceiptStore(pool),
    ops: new PgOpsStore(pool),
  };
}
