import type { ExtractJob } from '../queues.js';
import type { ProcessorDeps, JobLike } from './deps.js';
import { runIdempotentHandler } from './handler.js';
import { TransientError } from '../errors.js';

export async function processExtractJob(
  job: JobLike<ExtractJob>,
  deps: ProcessorDeps
): Promise<void> {
  return runIdempotentHandler({
    queue: 'extract',
    job,
    deps,
    work: async (ctx) => {
      // Check if cancelled before starting
      await ctx.throwIfCancelled();

      // Run extract step
      const result = await deps.research.runExtractStep(
        job.data.runId,
        job.data.sourceSnapshotId,
        { cancelled: false }
      );

      // Check provider availability
      if (result.providerUnavailable) {
        throw new TransientError('research provider unavailable');
      }

      // Emit outbox events in a single transaction
      await deps.outbox.transaction(async (tx) => {
        if (result.nextEvents.length > 0) {
          await deps.outbox.insertOutboxEvents(tx, result.nextEvents);
        }
      });
    },
  });
}
