/**
 * Idempotent handler wrapper (brief §8).
 *
 * Business dedup lives in `job_records` (Postgres), never in BullMQ rows:
 * - record `succeeded` → duplicate delivery is skipped, no business effect.
 * - any other state (missing, queued, running, interrupted, failed) → the
 *   work runs. BullMQ retries of the same job re-run the work, so every
 *   `work` implementation MUST be idempotent (DB uniqueness, versionExists
 *   checks, on-chain state checks before submitting).
 * - queue job removal never erases the `succeeded` marker.
 *
 * Error mapping: PermanentError → BullMQ UnrecoverableError (dead letter,
 * failed review, never retried). Anything else → rethrown for BullMQ retry
 * with the custom backoff strategy.
 *
 * The originating outbox event (when `job.data.outboxEventId` is present) is
 * marked done/failed alongside the job record so crash recovery stops
 * redelivering completed work.
 */
import { UnrecoverableError } from 'bullmq';
import type { QueueName, JobEnvelope } from '../queues.js';
import type { ProcessorDeps, JobLike } from './deps.js';
import { PermanentError } from '../errors.js';
import { MAX_ATTEMPTS } from '../backoff.js';
import type { Logger } from '../logging.js';

export interface HandlerCtx {
  log: Logger;
  now(): string;
  throwIfCancelled(): Promise<void>;
}

function outboxEventIdOf(data: JobEnvelope): string | null {
  const v = (data as unknown as Record<string, unknown>).outboxEventId;
  return typeof v === 'string' ? v : null;
}

export async function runIdempotentHandler(args: {
  queue: QueueName;
  job: JobLike<JobEnvelope>;
  deps: ProcessorDeps;
  work: (ctx: HandlerCtx) => Promise<void>;
}): Promise<void> {
  const { queue, job, deps, work } = args;
  const { outbox, logger, now: nowFn, workerId } = deps;
  const now = nowFn ?? (() => new Date().toISOString());

  const jobKey = typeof job.data.jobKey === 'string' ? job.data.jobKey : 'unknown-job-key';
  const eventId = outboxEventIdOf(job.data);
  const log = logger.child({ jobKey, traceId: job.data.traceId ?? jobKey, queue, workerId });

  if (job.data.schemaVersion !== 1) {
    // Permanent: the producer and worker disagree on the contract. Record it
    // and dead-letter without claiming work.
    const reason = `unsupported-payload-schema: expected 1, got ${String(job.data.schemaVersion)}`;
    await outbox.transaction(async (tx) => {
      await outbox.ensureJobRecord(tx, jobKey, queue, now());
      await outbox.setJobRecordStatus(tx, jobKey, 'failed', { lastError: reason });
    });
    log.warn('unsupported payload schema — dead letter', { jobKey });
    throw new UnrecoverableError(reason);
  }

  const existing = await outbox.transaction((tx) => outbox.getJobRecord(tx, jobKey));

  if (existing?.status === 'succeeded') {
    log.info('duplicate delivery after success — skipping', { jobKey });
    // Ensure the outbox event is closed so recovery stops redelivering it.
    if (eventId) {
      await outbox.transaction((tx) => outbox.markOutboxDone(tx, eventId, now()));
    }
    return;
  }

  if (existing?.cancelled === true || existing?.status === 'cancelled') {
    log.info('job was cancelled — skipping', { jobKey });
    await outbox.transaction((tx) => outbox.setJobRecordStatus(tx, jobKey, 'cancelled'));
    return;
  }

  // Claim (insert) or refresh the record, then mark running for this attempt.
  await outbox.transaction(async (tx) => {
    await outbox.ensureJobRecord(tx, jobKey, queue, now());
    await outbox.setJobRecordStatus(tx, jobKey, 'running', {
      attempts: job.attemptsMade + 1,
      heartbeatAt: now(),
    });
  });

  const ctx: HandlerCtx = {
    log,
    now,
    throwIfCancelled: async () => {
      const record = await outbox.transaction((tx) => outbox.getJobRecord(tx, jobKey));
      if (record?.cancelled === true || record?.status === 'cancelled') {
        throw new PermanentError('job-cancelled', `Job ${jobKey} was cancelled`);
      }
    },
  };

  try {
    await ctx.throwIfCancelled();
    await work(ctx);
    await outbox.transaction(async (tx) => {
      await outbox.setJobRecordStatus(tx, jobKey, 'succeeded');
      if (eventId) await outbox.markOutboxDone(tx, eventId, now());
    });
    log.info('job succeeded', { jobKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PermanentError) {
      await outbox.transaction(async (tx) => {
        await outbox.setJobRecordStatus(tx, jobKey, 'failed', { lastError: message });
        if (eventId) {
          await outbox.markOutboxFailed(tx, eventId, message, now());
        }
      });
      log.warn('job failed permanently — dead letter', { jobKey, reason: error.reason });
      throw new UnrecoverableError(`${error.reason}: ${message}`);
    }

    const isLastAttempt = job.attemptsMade + 1 >= MAX_ATTEMPTS;
    await outbox.transaction(async (tx) => {
      await outbox.setJobRecordStatus(tx, jobKey, isLastAttempt ? 'failed' : 'running', {
        lastError: message,
      });
      // The outbox event stays `dispatched` for transient failures: BullMQ is
      // still retrying, and crash recovery will redeliver only if the whole
      // worker died (stuck beyond the threshold).
    });
    log.warn('job attempt failed (transient)', {
      jobKey,
      attemptsMade: job.attemptsMade,
      isLastAttempt,
      error: message,
    });
    throw error;
  }
}
