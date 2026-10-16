import type { JobLike } from './deps.js';
import type { ReconcilePaymentJob } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import { PermanentError, TransientError } from '../errors.js';
import { ensureTransferSettled } from '../reconciler.js';
import type { ProcessorDepsEx } from './extended-deps.js';
import type { NewOutboxEvent } from '../db.js';

export interface PaymentLookup {
  getPriorSignature(orderId: string): Promise<string | null>;
}

export async function processReconcilePaymentJob(
  job: JobLike<ReconcilePaymentJob>,
  deps: ProcessorDepsEx & { paymentLookup?: PaymentLookup },
): Promise<void> {
  await runIdempotentHandler({
    queue: 'reconcile-payment',
    job,
    deps,
    work: async (ctx) => {
      if (!deps.paymentsEnabled) {
        throw new PermanentError('payments-disabled', 'Payments are not enabled');
      }

      if (!deps.paymentLookup) {
        ctx.log.warn('No payment lookup wired — reconciliation deferred', { orderId: job.data.orderId });
        return;
      }

      const { orderId, intentId } = job.data;
      const priorSignature = await deps.paymentLookup.getPriorSignature(orderId);

      const outcome = await ensureTransferSettled(
        {
          receipts: deps.receipts,
          solana: deps.solana,
          rpcUrls: deps.rpcUrls,
          logger: ctx.log,
          now: ctx.now,
        },
        {
          kind: 'payment',
          referenceId: intentId,
          priorSignature,
        },
      );

      ctx.log.info('Payment settlement check complete', { outcome });

      if (outcome.settled) {
        const outboxEvents: NewOutboxEvent[] = [
          {
            aggregateType: 'payment',
            aggregateId: orderId,
            eventType: 'payment.settled',
            payload: { orderId, intentId },
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
