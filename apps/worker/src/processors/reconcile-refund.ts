import type { JobLike } from './deps.js';
import type { ReconcileRefundJob } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import { PermanentError, TransientError } from '../errors.js';
import { ensureTransferSettled } from '../reconciler.js';
import type { ProcessorDepsEx } from './extended-deps.js';
import type { NewOutboxEvent } from '../db.js';

export interface RefundLookup {
  getPriorSignature(refundId: string): Promise<string | null>;
}

export async function processReconcileRefundJob(
  job: JobLike<ReconcileRefundJob>,
  deps: ProcessorDepsEx & { refundLookup?: RefundLookup },
): Promise<void> {
  await runIdempotentHandler({
    queue: 'reconcile-refund',
    job,
    deps,
    work: async (ctx) => {
      if (!deps.paymentsEnabled) {
        throw new PermanentError('payments-disabled', 'Payments are not enabled');
      }

      if (!deps.refundLookup) {
        ctx.log.warn('No refund lookup wired — reconciliation deferred', { refundId: job.data.refundId });
        return;
      }

      const { refundId, orderId } = job.data;
      const priorSignature = await deps.refundLookup.getPriorSignature(refundId);

      const outcome = await ensureTransferSettled(
        {
          receipts: deps.receipts,
          solana: deps.solana,
          rpcUrls: deps.rpcUrls,
          logger: ctx.log,
          now: ctx.now,
        },
        {
          kind: 'refund',
          referenceId: refundId,
          priorSignature,
        },
      );

      ctx.log.info('Refund settlement check complete', { outcome });

      if (outcome.settled) {
        const outboxEvents: NewOutboxEvent[] = [
          {
            aggregateType: 'refund',
            aggregateId: refundId,
            eventType: 'refund.settled',
            payload: { refundId, orderId },
          },
        ];

        await deps.receipts.transaction(async (tx) => {
          await deps.outbox.insertOutboxEvents(tx, outboxEvents);
        });
      } else if (
        outcome.status === 'unknown' ||
        outcome.status === 'confirmed'
      ) {
        throw new TransientError(
          'Settlement indeterminate — manual review before any new transfer',
        );
      }
    },
  });
}
