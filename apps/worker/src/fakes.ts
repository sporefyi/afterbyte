/**
 * In-memory implementations of the db.ts ports for unit tests.
 * No Postgres, no Redis. Transaction semantics: the fake runs the callback
 * directly; tests that need torn-write simulation do it explicitly.
 */
import type {
  JobRecord,
  JobRecordStatus,
  Lease,
  NewOutboxEvent,
  OutboxEvent,
  OutboxStore,
  LeaseStore,
  OpsStore,
  PublicationReceipt,
  PublishedSubjectRow,
  ReadModel,
  ReadModelStore,
  ReceiptStatus,
  ReceiptStore,
  PublishStore,
  Tx,
  TxAttempt,
  DossierVersionDraft,
} from './db.js';

const memTx: Tx = { __brand: 'Tx' };
const nowIso = () => new Date().toISOString();
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}-${Date.now().toString(36)}`;

export class MemOutboxStore implements OutboxStore {
  events = new Map<string, OutboxEvent>();
  handled = new Set<string>();
  jobs = new Map<string, JobRecord>();

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(memTx);
  }

  async insertOutboxEvents(_tx: Tx, events: NewOutboxEvent[]): Promise<OutboxEvent[]> {
    return events.map((e) => {
      const ev: OutboxEvent = {
        id: nextId('evt'),
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        eventType: e.eventType,
        payload: e.payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: nowIso(),
        dispatchedAt: null,
        jobId: null,
        lastError: null,
        createdAt: nowIso(),
      };
      this.events.set(ev.id, ev);
      return ev;
    });
  }

  async claimOutboxBatch(_tx: Tx, limit: number, now: string): Promise<OutboxEvent[]> {
    const due = [...this.events.values()]
      .filter((e) => e.status === 'pending' && e.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    for (const e of due) {
      e.status = 'dispatched';
      e.dispatchedAt = now;
      e.attempts += 1;
    }
    return due;
  }

  async markOutboxDispatched(_tx: Tx, id: string, jobId: string, now: string): Promise<void> {
    const e = this.events.get(id);
    if (e) {
      e.status = 'dispatched';
      e.dispatchedAt = now;
      e.jobId = jobId;
    }
  }

  async markOutboxDone(_tx: Tx, id: string): Promise<void> {
    const e = this.events.get(id);
    if (e) e.status = 'done';
  }

  async markOutboxFailed(_tx: Tx, id: string, error: string, nextAttemptAt: string): Promise<void> {
    const e = this.events.get(id);
    if (e) {
      e.status = 'failed';
      e.lastError = error;
      e.nextAttemptAt = nextAttemptAt;
    }
  }

  async listStuckDispatched(_tx: Tx, olderThan: string, limit: number): Promise<OutboxEvent[]> {
    return [...this.events.values()]
      .filter((e) => e.status === 'dispatched' && (e.dispatchedAt ?? '') <= olderThan)
      .slice(0, limit);
  }

  async resetStuckToPending(_tx: Tx, ids: string[], now: string): Promise<void> {
    for (const id of ids) {
      const e = this.events.get(id);
      if (e && e.status === 'dispatched') {
        e.status = 'pending';
        e.nextAttemptAt = now;
        e.dispatchedAt = null;
      }
    }
  }

  async countPendingOutbox(_tx: Tx): Promise<number> {
    return [...this.events.values()].filter((e) => e.status === 'pending').length;
  }

  async hasHandledEvent(_tx: Tx, eventId: string, consumer: string): Promise<boolean> {
    return this.handled.has(`${consumer}:${eventId}`);
  }

  async recordHandledEvent(_tx: Tx, eventId: string, consumer: string): Promise<void> {
    this.handled.add(`${consumer}:${eventId}`);
  }

  publicEvents: Array<{ eventType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: string }> = [];

  async insertPublicEvent(
    _tx: Tx,
    event: { eventType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: string },
  ): Promise<void> {
    this.publicEvents.push(event);
  }

  async ensureJobRecord(_tx: Tx, jobKey: string, queue: string, now: string): Promise<void> {
    if (!this.jobs.has(jobKey)) {
      this.jobs.set(jobKey, {
        jobKey,
        queue,
        status: 'queued',
        attempts: 0,
        heartbeatAt: null,
        cancelled: false,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async getJobRecord(_tx: Tx, jobKey: string): Promise<JobRecord | null> {
    return this.jobs.get(jobKey) ?? null;
  }

  async setJobRecordStatus(
    _tx: Tx,
    jobKey: string,
    status: JobRecordStatus,
    patch: { attempts?: number; lastError?: string | null; heartbeatAt?: string | null } = {},
  ): Promise<void> {
    const r = this.jobs.get(jobKey);
    if (!r) throw new Error(`unknown job key ${jobKey}`);
    r.status = status;
    if (patch.attempts !== undefined) r.attempts = patch.attempts;
    if (patch.lastError !== undefined) r.lastError = patch.lastError;
    if (patch.heartbeatAt !== undefined) r.heartbeatAt = patch.heartbeatAt;
    r.updatedAt = nowIso();
  }

  async heartbeatJob(_tx: Tx, jobKey: string, now: string): Promise<void> {
    const r = this.jobs.get(jobKey);
    if (r) {
      r.heartbeatAt = now;
      r.updatedAt = now;
    }
  }

  async cancelJob(_tx: Tx, jobKey: string): Promise<void> {
    const r = this.jobs.get(jobKey);
    if (r) {
      r.cancelled = true;
      r.updatedAt = nowIso();
    }
  }

  async listStrandedJobs(_tx: Tx, olderThan: string, limit: number): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter(
        (r) =>
          r.status === 'running' && (r.heartbeatAt ?? r.updatedAt) <= olderThan && !r.cancelled,
      )
      .slice(0, limit);
  }
}

export class MemLeaseStore implements LeaseStore {
  leases = new Map<string, Lease>();

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(memTx);
  }

  async acquireLease(
    _tx: Tx,
    leaseKey: string,
    owner: string,
    ttlMs: number,
    now: string,
  ): Promise<Lease | null> {
    const existing = this.leases.get(leaseKey);
    if (existing && existing.expiresAt > now && existing.owner !== owner) return null;
    const lease: Lease = {
      leaseKey,
      owner,
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      heartbeatAt: now,
    };
    this.leases.set(leaseKey, lease);
    return lease;
  }

  async heartbeatLease(
    _tx: Tx,
    leaseKey: string,
    owner: string,
    ttlMs: number,
    now: string,
  ): Promise<boolean> {
    const existing = this.leases.get(leaseKey);
    if (!existing || existing.owner !== owner) return false;
    existing.heartbeatAt = now;
    existing.expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    return true;
  }

  async releaseLease(_tx: Tx, leaseKey: string, owner: string): Promise<void> {
    const existing = this.leases.get(leaseKey);
    if (existing && existing.owner === owner) this.leases.delete(leaseKey);
  }

  async getLease(_tx: Tx, leaseKey: string): Promise<Lease | null> {
    return this.leases.get(leaseKey) ?? null;
  }
}

export class MemReadModelStore implements ReadModelStore {
  subjects: PublishedSubjectRow[] = [];
  models = new Map<string, ReadModel>();
  sourceRevision = '0';

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(memTx);
  }

  async listPublishedSubjects(_tx: Tx): Promise<PublishedSubjectRow[]> {
    // The fake mirrors the production query contract: only published rows
    // are ever inserted here by tests.
    return [...this.subjects];
  }

  async upsertReadModel(_tx: Tx, model: Omit<ReadModel, 'updatedAt'>): Promise<void> {
    this.models.set(model.key, { ...model, updatedAt: nowIso() });
  }

  async getReadModel(_tx: Tx, key: string): Promise<ReadModel | null> {
    return this.models.get(key) ?? null;
  }

  async currentSourceRevision(_tx: Tx): Promise<string> {
    return this.sourceRevision;
  }
}

export class MemPublishStore implements PublishStore {
  drafts = new Map<string, DossierVersionDraft>();
  versions: Array<{
    subjectId: string;
    versionNumber: number;
    payloadHash: string;
    objectKey: string;
    publishedAt: string;
  }> = [];
  currentPointer = new Map<string, number>();
  outbox = new MemOutboxStore();

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(memTx);
  }

  async commitPublication(
    tx: Tx,
    args: {
      draft: DossierVersionDraft;
      canonicalBytes: Uint8Array;
      payloadHash: string;
      objectKey: string;
      publishedAt: string;
      outboxEvents: NewOutboxEvent[];
    },
  ): Promise<void> {
    if (this.versions.some((v) => v.subjectId === args.draft.subjectId && v.versionNumber === args.draft.versionNumber)) {
      throw new Error('duplicate version');
    }
    this.versions.push({
      subjectId: args.draft.subjectId,
      versionNumber: args.draft.versionNumber,
      payloadHash: args.payloadHash,
      objectKey: args.objectKey,
      publishedAt: args.publishedAt,
    });
    this.currentPointer.set(args.draft.subjectId, args.draft.versionNumber);
    await this.outbox.insertOutboxEvents(tx, args.outboxEvents);
  }

  async getDraftForPublish(_tx: Tx, draftId: string): Promise<DossierVersionDraft | null> {
    return this.drafts.get(draftId) ?? null;
  }

  async versionExists(_tx: Tx, subjectId: string, versionNumber: number): Promise<boolean> {
    return this.versions.some(
      (v) => v.subjectId === subjectId && v.versionNumber === versionNumber,
    );
  }
}

export class MemReceiptStore implements ReceiptStore {
  receipts = new Map<string, PublicationReceipt>();
  attempts: TxAttempt[] = [];

  private key(subjectId: string, versionNumber: number) {
    return `${subjectId}:v${versionNumber}`;
  }

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(memTx);
  }

  async getReceipt(_tx: Tx, subjectId: string, versionNumber: number): Promise<PublicationReceipt | null> {
    return this.receipts.get(this.key(subjectId, versionNumber)) ?? null;
  }

  async upsertReceipt(_tx: Tx, receipt: PublicationReceipt): Promise<void> {
    this.receipts.set(this.key(receipt.subjectId, receipt.versionNumber), receipt);
  }

  async recordTxAttempt(
    _tx: Tx,
    attempt: Omit<TxAttempt, 'id' | 'createdAt'>,
  ): Promise<TxAttempt> {
    const row: TxAttempt = { ...attempt, id: nextId('txa'), createdAt: nowIso() };
    this.attempts.push(row);
    return row;
  }

  async updateTxAttempt(
    tx: Tx,
    id: string,
    patch: { status: ReceiptStatus; slot?: number | null; error?: string | null; signature?: string },
  ): Promise<void> {
    const a = this.attempts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown tx attempt ${id}`);
    a.status = patch.status;
    if (patch.slot !== undefined) a.slot = patch.slot;
    if (patch.error !== undefined) a.error = patch.error;
    if (patch.signature !== undefined) a.signature = patch.signature;
  }

  async listAttemptsForReceipt(
    _tx: Tx,
    subjectId: string,
    versionNumber: number,
  ): Promise<TxAttempt[]> {
    return this.attempts.filter(
      (a) => a.subjectId === subjectId && a.versionNumber === versionNumber,
    );
  }

  async listReceiptsNeedingRecheck(_tx: Tx, limit: number): Promise<PublicationReceipt[]> {
    return [...this.receipts.values()]
      .filter((r) => r.status === 'pending' || r.status === 'submitted' || r.status === 'confirmed')
      .slice(0, limit);
  }
}

export class MemOpsStore implements OpsStore {
  heartbeats: Array<Record<string, unknown>> = [];

  async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(memTx);
  }

  async upsertWorkerHeartbeat(
    _tx: Tx,
    args: { workerId: string; queues: string[]; startedAt: string; now: string; stats?: Record<string, unknown> },
  ): Promise<void> {
    this.heartbeats.push({ ...args });
  }

  async pruneHandledEvents(_tx: Tx, _olderThan: string): Promise<number> {
    return 0;
  }

  async pruneDoneOutbox(_tx: Tx, _olderThan: string): Promise<number> {
    return 0;
  }
}

/** One combined fake for tests needing several ports. */
export class MemStores {
  readonly outbox = new MemOutboxStore();
  readonly leases = new MemLeaseStore();
  readonly readmodels = new MemReadModelStore();
  readonly publish = new MemPublishStore();
  readonly receipts = new MemReceiptStore();
  readonly ops = new MemOpsStore();
}
