import type { DraftJob } from '../queues.js';
import type { ProcessorDeps, JobLike } from './deps.js';
import { runIdempotentHandler } from './handler.js';
import { TransientError } from '../errors.js';

export async function processDraftJob(
  job: JobLike<DraftJob>,
  deps: ProcessorDeps
): Promise<void> {
  return runIdempotentHandler({
    queue: 'draft',
    job,
    deps,
    work: async (ctx) => {
      // Check if cancelled before starting
      await ctx.throwIfCancelled();

      // Run draft step
      const result = await deps.research.runDraftStep(
        job.data.runId,
        job.data.dossierDraftId,
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
