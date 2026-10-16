/**
 * Outbox: dispatcher, crash recovery, and transactional consumer dedup —
 * all against the in-memory store (no Postgres, no Redis).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  dispatchOutboxTick,
  buildBullMqPayload,
  consumeOutboxEvent,
  reconcileOutboxAfterCrash,
} from '../src/outbox.js';
import { MemOutboxStore } from '../src/fakes.js';
import { createLogger } from '../src/logging.js';
import type { Queue } from 'bullmq';
import type { QueueName } from '../src/queues.js';

const logger = createLogger({ test: 'outbox' });

function fakeQueues() {
  const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
  const queues = new Map<QueueName, Queue>();
  const fake = {
    add: async (name: string, data: unknown, opts: unknown) => {
      added.push({ name, data, opts });
      return { id: `bullmq-${added.length}` };
    },
  } as unknown as Queue;
  for (const q of ['publish', 'anchor-receipt'] as QueueName[]) queues.set(q, fake);
  return { queues, added };
}

describe('buildBullMqPayload', () => {
  it('merges the envelope with the event payload (IDs only, never articles)', () => {
    const payload = buildBullMqPayload({
      id: 'evt-1',
      aggregateType: 'dossier',
      aggregateId: 'sub-1',
      eventType: 'editorial.version.publish.requested',
      payload: { subjectId: 'sub-1', versionNumber: 2, jobKey: 'publish:sub-1:v2', traceId: 't-1' },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-10-16T00:00:00Z',
      dispatchedAt: null,
      jobId: null,
      lastError: null,
      createdAt: '2026-10-16T00:00:00Z',
    });
    expect(payload).toMatchObject({
      schemaVersion: 1,
      jobKey: 'publish:sub-1:v2',
      traceId: 't-1',
      subjectId: 'sub-1',
      versionNumber: 2,
    });
  });

  it('falls back to the outbox-scoped key when the payload has none', () => {
    const payload = buildBullMqPayload({
      id: 'evt-9',
      aggregateType: 'x',
      aggregateId: 'y',
      eventType: 'receipt.anchor.requested',
      payload: { subjectId: 's' },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-10-16T00:00:00Z',
      dispatchedAt: null,
      jobId: null,
      lastError: null,
      createdAt: '2026-10-16T00:00:00Z',
    });
    expect(payload.jobKey).toBe('outbox:evt-9');
  });
});

describe('dispatchOutboxTick', () => {
  let store: MemOutboxStore;
  beforeEach(() => {
    store = new MemOutboxStore();
  });

  it('dispatches due events with deterministic BullMQ job ids', async () => {
    await store.transaction((tx) =>
      store.insertOutboxEvents(tx, [
        {
          aggregateType: 'dossier',
          aggregateId: 'sub-1',
          eventType: 'editorial.version.publish.requested',
          payload: { subjectId: 'sub-1', versionNumber: 1, jobKey: 'publish:sub-1:v1' },
        },
      ]),
    );
    // NOTE: 'editorial.version.publish.requested' is not in OUTBOX_EVENT_ROUTES;
    // use a routed type instead.
    store.events.clear();
    await store.transaction((tx) =>
      store.insertOutboxEvents(tx, [
        {
          aggregateType: 'receipt',
          aggregateId: 'sub-1:1',
          eventType: 'receipt.anchor.requested',
          payload: { subjectId: 'sub-1', versionNumber: 1, jobKey: 'anchor-receipt:sub-1:v1' },
        },
      ]),
    );
    const { queues, added } = fakeQueues();
    const stats = await dispatchOutboxTick({ store, queues, logger });
    expect(stats).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    expect(added).toHaveLength(1);
    expect(added[0].opts).toMatchObject({ jobId: expect.stringMatching(/^outbox:/) });
    // Deterministic: the BullMQ jobId derives from the event id.
    const eventId = [...store.events.keys()][0];
    expect((added[0].opts as { jobId: string }).jobId).toBe(`outbox:${eventId}`);
  });

  it('writes public SSE events to the public log instead of a queue', async () => {
    await store.transaction((tx) =>
      store.insertOutboxEvents(tx, [
        {
          aggregateType: 'dossier',
          aggregateId: 'sub-1',
          eventType: 'dossier.published',
          payload: { subjectId: 'sub-1', versionNumber: 3 },
        },
      ]),
    );
    const { queues, added } = fakeQueues();
    const stats = await dispatchOutboxTick({ store, queues, logger });
    expect(stats.dispatched).toBe(1);
    expect(added).toHaveLength(0);
    expect(store.publicEvents).toHaveLength(1);
    expect(store.publicEvents[0]).toMatchObject({
      eventType: 'dossier.published',
      aggregateId: 'sub-1',
    });
    const event = [...store.events.values()][0];
    expect(event.status).toBe('done');
  });

  it('marks unknown routes failed without aborting the tick', async () => {
    await store.transaction((tx) =>
      store.insertOutboxEvents(tx, [
        { aggregateType: 'x', aggregateId: 'y', eventType: 'nope.unknown', payload: {} },
        {
          aggregateType: 'receipt',
          aggregateId: 'sub-1:1',
          eventType: 'receipt.anchor.requested',
          payload: { subjectId: 'sub-1', versionNumber: 1, jobKey: 'k' },
        },
      ]),
    );
    const { queues } = fakeQueues();
    const stats = await dispatchOutboxTick({ store, queues, logger });
    expect(stats).toMatchObject({ claimed: 2, dispatched: 1, unknownRoutes: 1 });
    const failed = [...store.events.values()].find((e) => e.eventType === 'nope.unknown');
    expect(failed?.status).toBe('failed');
  });
});

describe('consumeOutboxEvent', () => {
  it('applies once and dedups the redelivery transactionally', async () => {
    const store = new MemOutboxStore();
    let applies = 0;
    const apply = async () => {
      applies++;
    };
    expect(await consumeOutboxEvent(store, 'test-consumer', 'evt-1', apply)).toBe('applied');
    expect(await consumeOutboxEvent(store, 'test-consumer', 'evt-1', apply)).toBe('duplicate');
    expect(applies).toBe(1);
  });

  it('does not record handling when apply throws (redelivery retries)', async () => {
    const store = new MemOutboxStore();
    const boom = async () => {
      throw new Error('transient');
    };
    await expect(consumeOutboxEvent(store, 'c', 'evt-2', boom)).rejects.toThrow('transient');
    expect(await store.transaction((tx) => store.hasHandledEvent(tx, 'evt-2', 'c'))).toBe(false);
  });
});

describe('reconcileOutboxAfterCrash', () => {
  it('redelivers stuck dispatched events and marks stranded jobs interrupted', async () => {
    const store = new MemOutboxStore();
    const old = new Date(Date.now() - 3600_000).toISOString();
    await store.transaction(async (tx) => {
      const [e] = await store.insertOutboxEvents(tx, [
        { aggregateType: 'a', aggregateId: 'b', eventType: 'receipt.anchor.requested', payload: {} },
      ]);
      await store.markOutboxDispatched(tx, e.id, 'bullmq-1', old);
      await store.ensureJobRecord(tx, 'publish:sub-1:v1', 'publish', old);
      await store.setJobRecordStatus(tx, 'publish:sub-1:v1', 'running', { heartbeatAt: old });
    });

    const result = await reconcileOutboxAfterCrash(store, logger, { stuckAfterSec: 60 });
    expect(result).toMatchObject({ redelivered: 1, strandedJobs: 1 });

    const event = [...store.events.values()][0];
    expect(event.status).toBe('pending');
    const job = await store.transaction((tx) => store.getJobRecord(tx, 'publish:sub-1:v1'));
    expect(job?.status).toBe('interrupted');
  });

  it('leaves fresh dispatched events and heartbeated jobs alone', async () => {
    const store = new MemOutboxStore();
    const now = new Date().toISOString();
    await store.transaction(async (tx) => {
      const [e] = await store.insertOutboxEvents(tx, [
        { aggregateType: 'a', aggregateId: 'b', eventType: 'receipt.anchor.requested', payload: {} },
      ]);
      await store.markOutboxDispatched(tx, e.id, 'bullmq-1', now);
      await store.ensureJobRecord(tx, 'publish:sub-1:v1', 'publish', now);
      await store.setJobRecordStatus(tx, 'publish:sub-1:v1', 'running', { heartbeatAt: now });
    });
    const result = await reconcileOutboxAfterCrash(store, logger, { stuckAfterSec: 600 });
    expect(result).toMatchObject({ redelivered: 0, strandedJobs: 0 });
  });
});
