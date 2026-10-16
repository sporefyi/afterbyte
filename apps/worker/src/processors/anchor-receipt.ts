import type { JobLike } from './deps.js';
import type { AnchorReceiptJob } from '../queues.js';
import { jobKeys } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import { anchorReceipt } from '../reconciler.js';
import type { PublicationKindLabel } from '@afterbyte/solana';
import type { ProcessorDepsEx } from './extended-deps.js';
import type { NewOutboxEvent } from '../db.js';

export async function processAnchorReceiptJob(
  job: JobLike<AnchorReceiptJob>,
  deps: ProcessorDepsEx,
): Promise<void> {
  await runIdempotentHandler({
    queue: 'anchor-receipt',
    job,
    deps,
    work: async (ctx) => {
      const { subjectId, versionNumber, payloadHash, publicationKind } = job.data;

      const outcome = await anchorReceipt(
        {
          receipts: deps.receipts,
          solana: deps.solana,
          rpcUrls: deps.rpcUrls,
          logger: ctx.log,
          now: ctx.now,
        },
        { subjectId, versionNumber, payloadHash, publicationKind: publicationKind as PublicationKindLabel },
      );

      ctx.log.info(outcome.note, { outcome });

      if (outcome.status === 'submitted') {
        const outboxEvents: NewOutboxEvent[] = [
          {
            aggregateType: 'receipt',
            aggregateId: `${subjectId}:${versionNumber}`,
            eventType: 'receipt.recheck.requested',
            payload: {
              subjectId,
              versionNumber,
              jobKey: jobKeys.recheckReceipt(subjectId, versionNumber),
            },
          },
        ];

        await deps.receipts.transaction(async (tx) => {
          await deps.outbox.insertOutboxEvents(tx, outboxEvents);
        });
      }
    },
  });
}
