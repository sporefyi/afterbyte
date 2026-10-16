/**
 * Idempotency: duplicate delivery AFTER success causes no business effect;
 * BullMQ retries of the same job re-run idempotent work; business dedup
 * lives in job_records (Postgres), never in BullMQ rows. Permanent errors
 * become BullMQ UnrecoverableError (dead letter, no retry).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { runIdempotentHandler } from '../src/processors/handler.js';
import type { ProcessorDeps } from '../src/processors/deps.js';
import { MemOutboxStore } from '../src/fakes.js';
import { createLogger } from '../src/logging.js';
import { PermanentError, TransientError } from '../src/errors.js';
import type { DiscoveryJob } from '../src/queues.js';

function makeDeps(store: MemOutboxStore): ProcessorDeps {
  return {
    outbox: store,
    research: {
      runDiscoveryStep: async () => ({ outputIds: [], nextEvents: [] }),
      runFetchStep: async () => ({ outputIds: [], nextEvents: [] }),
      runExtractStep: async () => ({ outputIds: [], nextEvents: [] }),
      runDraftStep: async () => ({ outputIds: [], nextEvents: [] }),
      runReviewPreflight: async () => ({ outputIds: [], nextEvents: [] }),
    },
    logger: createLogger({ test: 'idempotency' }),
    workerId: 'test-worker',
  };
}

function discoveryJob(jobKey: string, attemptsMade = 0, extra: Record<string, unknown> = {}) {
  return {
    data: { schemaVersion: 1 as const, jobKey, runId: 'run-1', ...extra } as DiscoveryJob,
    attemptsMade,
  };
}

describe('runIdempotentHandler', () => {
  let store: MemOutboxStore;
  let deps: ProcessorDeps;
  beforeEach(() => {
    store = new MemOutboxStore();
    deps = makeDeps(store);
  });

  it('same job key twice after success → one business effect', async () => {
    let effects = 0;
    const work = async () => {
      effects++;
    };
    const job = discoveryJob('discovery:run-1');
    await runIdempotentHandler({ queue: 'discovery', job, deps, work });
    await runIdempotentHandler({ queue: 'discovery', job, deps, work });
    expect(effects).toBe(1);
    const record = await store.transaction((tx) => store.getJobRecord(tx, 'discovery:run-1'));
    expect(record?.status).toBe('succeeded');
  });

  it('BullMQ retries re-run the work (retries are not swallowed as duplicates)', async () => {
    let effects = 0;
    const flaky = async () => {
      effects++;
      if (effects === 1) throw new TransientError('first attempt fails');
    };
    await expect(
      runIdempotentHandler({ queue: 'discovery', job: discoveryJob('k-retry', 0), deps, work: flaky }),
    ).rejects.toBeInstanceOf(TransientError);
    // BullMQ retry: same job key, attemptsMade=1 → work runs again.
    await runIdempotentHandler({ queue: 'discovery', job: discoveryJob('k-retry', 1), deps, work: flaky });
    expect(effects).toBe(2);
    const record = await store.transaction((tx) => store.getJobRecord(tx, 'k-retry'));
    expect(record?.status).toBe('succeeded');
  });

  it('closes the outbox event on success so recovery stops redelivering', async () => {
    const [event] = await store.transaction((tx) =>
      store.insertOutboxEvents(tx, [
        { aggregateType: 'a', aggregateId: 'b', eventType: 'receipt.anchor.requested', payload: {} },
      ]),
    );
    await runIdempotentHandler({
      queue: 'discovery',
      job: discoveryJob('k-evt', 0, { outboxEventId: event.id } as unknown as Record<string, unknown>),
      deps,
      work: async () => undefined,
    });
    expect(store.events.get(event.id)?.status).toBe('done');
  });

  it('converts PermanentError to UnrecoverableError and marks failed', async () => {
    const work = async () => {
      throw new PermanentError('schema-invalid', 'draft failed schema checks');
    };
    await expect(
      runIdempotentHandler({ queue: 'discovery', job: discoveryJob('k-perm'), deps, work }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    const record = await store.transaction((tx) => store.getJobRecord(tx, 'k-perm'));
    expect(record?.status).toBe('failed');
    expect(record?.lastError).toContain('schema checks');
  });

  it('keeps transient failures retryable until the final attempt', async () => {
    const work = async () => {
      throw new TransientError('provider timeout');
    };
    await expect(
      runIdempotentHandler({ queue: 'discovery', job: discoveryJob('k-trans', 0), deps, work }),
    ).rejects.toBeInstanceOf(TransientError);
    let record = await store.transaction((tx) => store.getJobRecord(tx, 'k-trans'));
    expect(record?.status).toBe('running');
    expect(record?.attempts).toBe(1);

    await expect(
      runIdempotentHandler({ queue: 'discovery', job: discoveryJob('k-trans', 2), deps, work }),
    ).rejects.toBeInstanceOf(TransientError);
    record = await store.transaction((tx) => store.getJobRecord(tx, 'k-trans'));
    expect(record?.status).toBe('failed');
  });

  it('skips cancelled jobs without running work', async () => {
    let effects = 0;
    const now = new Date().toISOString();
    await store.transaction(async (tx) => {
      await store.ensureJobRecord(tx, 'k-cancel', 'discovery', now);
      await store.cancelJob(tx, 'k-cancel');
    });
    await runIdempotentHandler({
      queue: 'discovery',
      job: discoveryJob('k-cancel'),
      deps,
      work: async () => {
        effects++;
      },
    });
    expect(effects).toBe(0);
    const record = await store.transaction((tx) => store.getJobRecord(tx, 'k-cancel'));
    expect(record?.status).toBe('cancelled');
  });

  it('rejects unsupported payload schema versions permanently', async () => {
    const job = {
      data: { schemaVersion: 2, jobKey: 'k-bad-schema', runId: 'run-1' } as unknown as DiscoveryJob,
      attemptsMade: 0,
    };
    await expect(
      runIdempotentHandler({ queue: 'discovery', job, deps, work: async () => undefined }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('survives queue job removal: succeeded marker persists in job_records', async () => {
    // Simulate: BullMQ job row was removed after completion (removeOnComplete),
    // then the outbox redispatches the same logical work as a NEW BullMQ job.
    const job = discoveryJob('publish:sub-9:v1');
    let effects = 0;
    await runIdempotentHandler({ queue: 'publish', job, deps, work: async () => { effects++; } });
    // New BullMQ job, same business key (outbox redelivery after job removal).
    await runIdempotentHandler({ queue: 'publish', job: discoveryJob('publish:sub-9:v1'), deps, work: async () => { effects++; } });
    expect(effects).toBe(1);
  });
});

describe('job key determinism', () => {
  it('outboxEventId is carried in the BullMQ payload', async () => {
    const { buildBullMqPayload } = await import('../src/outbox.js');
    const payload = buildBullMqPayload({
      id: 'evt-42',
      aggregateType: 'a',
      aggregateId: 'b',
      eventType: 'receipt.anchor.requested',
      payload: { jobKey: 'anchor-receipt:s:v1' },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-10-16T00:00:00Z',
      dispatchedAt: null,
      jobId: null,
      lastError: null,
      createdAt: '2026-10-16T00:00:00Z',
    });
    expect(payload.outboxEventId).toBe('evt-42');
    expect(payload.jobKey).toBe('anchor-receipt:s:v1');
    expect(payload.schemaVersion).toBe(1);
  });
});
