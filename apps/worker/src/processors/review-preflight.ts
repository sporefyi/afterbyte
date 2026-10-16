import type { ReviewPreflightJob } from '../queues.js';
import type { ProcessorDeps, JobLike } from './deps.js';
import { runIdempotentHandler } from './handler.js';

export async function processReviewPreflightJob(
  job: JobLike<ReviewPreflightJob>,
  deps: ProcessorDeps
): Promise<void> {
  return runIdempotentHandler({
    queue: 'review-preflight',
    job,
    deps,
    work: async (ctx) => {
      // Check if cancelled before starting
      await ctx.throwIfCancelled();

      // Run review preflight step
      // Note: runReviewPreflight throws PermanentError on invalid draft state.
      // This error propagates through the handler, which converts it to UnrecoverableError,
      // marking the job as failed and sending it to the dead letter queue.
      // This ensures invalid drafts never retry and are flagged for manual review.
      const result = await deps.research.runReviewPreflight(
        job.data.dossierDraftId,
        { cancelled: false }
      );

      // Emit outbox events in a single transaction
      await deps.outbox.transaction(async (tx) => {
        if (result.nextEvents.length > 0) {
          await deps.outbox.insertOutboxEvents(tx, result.nextEvents);
        }
      });
    },
  });
}
