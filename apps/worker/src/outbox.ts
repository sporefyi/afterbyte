import type { Queue } from 'bullmq';
import type { OutboxStore, Tx, NewOutboxEvent } from './db.js';
import type { OutboxEvent } from './types.js';
import type { QueueName } from './queues.js';
import { OUTBOX_EVENT_ROUTES, PUBLIC_EVENT_TYPES, jobKeys } from './queues.js';
import { defaultJobOptions } from './backoff.js';
import type { Logger } from './logging.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function emitOutboxEvents(
  store: OutboxStore,
  tx: Tx,
  events: NewOutboxEvent[],
): Promise<OutboxEvent[]> {
  return store.insertOutboxEvents(tx, events);
}

export interface OutboxDispatcherDeps {
  store: OutboxStore;
  queues: Map<QueueName, Queue>;
  logger: Logger;
  batchSize?: number;
}

export interface DispatchStats {
  claimed: number;
  dispatched: number;
  failed: number;
  unknownRoutes: number;
}

export async function dispatchOutboxTick(
  deps: OutboxDispatcherDeps,
): Promise<DispatchStats> {
  const { store, queues, logger, batchSize = 100 } = deps;
  const now = nowIso();

  const stats: DispatchStats = {
    claimed: 0,
    dispatched: 0,
    failed: 0,
    unknownRoutes: 0,
  };

  const claimed = await store.transaction(async (tx) => {
    return store.claimOutboxBatch(tx, batchSize, now);
  });

  stats.claimed = claimed.length;

  for (const event of claimed) {
    // Public SSE events go to the durable public_events log, not a queue.
    if (PUBLIC_EVENT_TYPES.has(event.eventType)) {
      try {
        await store.transaction(async (tx) => {
          await store.insertPublicEvent(tx, {
            eventType: event.eventType,
            aggregateId: event.aggregateId,
            payload: event.payload,
            occurredAt: now,
          });
          await store.markOutboxDone(tx, event.id, now);
        });
        stats.dispatched++;
        logger.debug('public event logged', { eventId: event.id, eventType: event.eventType });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const nextAttemptAt = new Date(Date.parse(now) + 60_000).toISOString();
        await store.transaction(async (tx) => {
          await store.markOutboxFailed(tx, event.id, errorMsg, nextAttemptAt);
        });
        stats.failed++;
        logger.error('public event log failed', { eventId: event.id, error: errorMsg });
      }
      continue;
    }

    const queueName = OUTBOX_EVENT_ROUTES[event.eventType];

    if (!queueName) {
      // Unknown event type: mark as failed, do not throw
      const nextAttemptAt = new Date(Date.parse(now) + 60_000).toISOString();
      await store.transaction(async (tx) => {
        await store.markOutboxFailed(
          tx,
          event.id,
          `Unknown event type: ${event.eventType}`,
          nextAttemptAt,
        );
      });
      stats.unknownRoutes++;
      logger.warn('outbox event has unknown route', {
        eventId: event.id,
        eventType: event.eventType,
      });
      continue;
    }

    const queue = queues.get(queueName);
    if (!queue) {
      // Queue not configured: mark as failed
      const nextAttemptAt = new Date(Date.parse(now) + 60_000).toISOString();
      await store.transaction(async (tx) => {
        await store.markOutboxFailed(
          tx,
          event.id,
          `Queue not configured: ${queueName}`,
          nextAttemptAt,
        );
      });
      stats.unknownRoutes++;
      logger.warn('outbox event queue not configured', {
        eventId: event.id,
        queueName,
      });
      continue;
    }

    const payload = buildBullMqPayload(event);
    const jobId = jobKeys.outboxEvent(event.id);

    try {
      const job = await queue.add('process', payload, defaultJobOptions(jobId));

      // Mark as dispatched in a transaction
      await store.transaction(async (tx) => {
        await store.markOutboxDispatched(tx, event.id, job.id ?? jobId, now);
      });

      stats.dispatched++;
      logger.debug('outbox event dispatched', {
        eventId: event.id,
        jobId: job.id,
        queueName,
      });
    } catch (err) {
      // Enqueue failure: mark as failed with retry window
      const nextAttemptAt = new Date(Date.parse(now) + 60_000).toISOString();
      const errorMsg =
        err instanceof Error ? err.message : String(err);
      await store.transaction(async (tx) => {
        await store.markOutboxFailed(tx, event.id, errorMsg, nextAttemptAt);
      });
      stats.failed++;
      logger.error('outbox event enqueue failed', {
        eventId: event.id,
        queueName,
        error: errorMsg,
      });
    }
  }

  return stats;
}

export function buildBullMqPayload(event: OutboxEvent): Record<string, unknown> {
  const jobKey =
    typeof event.payload.jobKey === 'string'
      ? event.payload.jobKey
      : jobKeys.outboxEvent(event.id);

  const traceId =
    typeof event.payload.traceId === 'string'
      ? event.payload.traceId
      : undefined;

  const envelope = {
    schemaVersion: 1,
    jobKey,
    ...(traceId && { traceId }),
    // Lets the processor close the outbox event on success/failure so crash
    // recovery stops redelivering completed work.
    outboxEventId: event.id,
  };

  return {
    ...envelope,
    ...event.payload,
  };
}

export async function consumeOutboxEvent(
  store: OutboxStore,
  consumer: string,
  eventId: string,
  apply: (tx: Tx) => Promise<void>,
): Promise<'applied' | 'duplicate'> {
  // Transaction ensures atomicity: if apply() throws, the entire transaction
  // rolls back, so hasHandledEvent will still return false on redelivery.
  // This allows the consumer to safely retry without double-applying.
  const result = await store.transaction(async (tx) => {
    const alreadyHandled = await store.hasHandledEvent(tx, eventId, consumer);
    if (alreadyHandled) {
      return 'duplicate' as const;
    }

    await apply(tx);
    const now = nowIso();
    await store.recordHandledEvent(tx, eventId, consumer, now);
    await store.markOutboxDone(tx, eventId, now);

    return 'applied' as const;
  });

  return result;
}

export interface ReconcileOutboxAfterCrashOpts {
  stuckAfterSec?: number;
  batchSize?: number;
  /** Max redeliveries of a stuck event before it is failed for manual review. */
  maxRedeliveries?: number;
}

export interface ReconcileOutboxAfterCrashResult {
  redelivered: number;
  strandedJobs: number;
}

export async function reconcileOutboxAfterCrash(
  store: OutboxStore,
  logger: Logger,
  opts?: ReconcileOutboxAfterCrashOpts,
): Promise<ReconcileOutboxAfterCrashResult> {
  const stuckAfterSec = opts?.stuckAfterSec ?? 300; // 5 minutes default
  const batchSize = opts?.batchSize ?? 100;
  const maxRedeliveries = opts?.maxRedeliveries ?? 5;
  const now = nowIso();
  const olderThan = new Date(
    Date.parse(now) - stuckAfterSec * 1000,
  ).toISOString();

  let redelivered = 0;
  let strandedJobs = 0;
  let exhausted = 0;

  // Find dispatched-but-unacked events and reset to pending — unless the
  // redelivery budget is exhausted, in which case fail for manual review
  // instead of looping forever.
  const stuckEvents = await store.transaction(async (tx) => {
    return store.listStuckDispatched(tx, olderThan, batchSize);
  });

  const redeliverable = stuckEvents.filter((e) => e.attempts < maxRedeliveries);
  const dead = stuckEvents.filter((e) => e.attempts >= maxRedeliveries);

  if (redeliverable.length > 0) {
    const ids = redeliverable.map((e) => e.id);
    await store.transaction(async (tx) => {
      await store.resetStuckToPending(tx, ids, now);
    });
    redelivered = ids.length;
    logger.info('reconciled stuck outbox events', {
      count: redelivered,
      olderThan,
    });
  }

  for (const e of dead) {
    const nextAttemptAt = new Date(Date.parse(now) + 3600_000).toISOString();
    await store.transaction(async (tx) => {
      await store.markOutboxFailed(
        tx,
        e.id,
        `redelivery budget exhausted after ${e.attempts} dispatches without ack`,
        nextAttemptAt,
      );
    });
    exhausted++;
  }
  if (exhausted > 0) {
    logger.warn('outbox events exhausted redelivery budget', { count: exhausted });
  }

  // Find stranded running jobs and mark as interrupted
  const strandedJobs_ = await store.transaction(async (tx) => {
    return store.listStrandedJobs(tx, olderThan, batchSize);
  });

  for (const job of strandedJobs_) {
    await store.transaction(async (tx) => {
      await store.setJobRecordStatus(tx, job.jobKey, 'interrupted');
    });
    strandedJobs++;
  }

  if (strandedJobs > 0) {
    logger.info('marked stranded jobs as interrupted', {
      count: strandedJobs,
      olderThan,
    });
  }

  return { redelivered, strandedJobs };
}
