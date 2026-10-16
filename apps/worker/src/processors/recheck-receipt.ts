import type { JobLike } from './deps.js';
import type { RecheckReceiptJob } from '../queues.js';
import { jobKeys } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import { recheckReceipt } from '../reconciler.js';
import type { ProcessorDepsEx } from './extended-deps.js';
import type { NewOutboxEvent } from '../db.js';

export async function processRecheckReceiptJob(
  job: JobLike<RecheckReceiptJob>,
  deps: ProcessorDepsEx,
): Promise<void> {
  await runIdempotentHandler({
    queue: 'recheck-receipt',
    job,
    deps,
    work: async (ctx) => {
      const { subjectId, versionNumber } = job.data;
      const round = job.data.round ?? 0;

      const outcome = await recheckReceipt(
        {
          receipts: deps.receipts,
          solana: deps.solana,
          rpcUrls: deps.rpcUrls,
          logger: ctx.log,
          now: ctx.now,
        },
        { subjectId, versionNumber },
      );

      ctx.log.info(outcome.note, { outcome });

      const outboxEvents: NewOutboxEvent[] = [];

      if (outcome.status === 'submitted' || outcome.status === 'confirmed') {
        // Not yet final; schedule another recheck if we haven't exceeded attempts.
        // The round bump keeps the deterministic job key unique per recheck round.
        if ((job.attemptsMade ?? 0) < 2) {
          outboxEvents.push({
            aggregateType: 'receipt',
            aggregateId: `${subjectId}:${versionNumber}`,
            eventType: 'receipt.recheck.requested',
            payload: {
              subjectId,
              versionNumber,
              round: round + 1,
              jobKey: jobKeys.recheckReceipt(subjectId, versionNumber, round + 1),
            },
          });
        } else {
          ctx.log.warn('Max recheck attempts reached', {
            subjectId,
            versionNumber,
            attempts: job.attemptsMade,
          });
        }
      } else if (outcome.status === 'finalized') {
        outboxEvents.push({
          aggregateType: 'receipt',
          aggregateId: `${subjectId}:${versionNumber}`,
          eventType: 'receipt.finalized',
          payload: { subjectId, versionNumber },
        });
      }

      if (outboxEvents.length > 0) {
        await deps.receipts.transaction(async (tx) => {
          await deps.outbox.insertOutboxEvents(tx, outboxEvents);
        });
      }
    },
  });
}
