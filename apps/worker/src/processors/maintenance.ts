import type { JobLike } from './deps.js';
import type { MaintenanceJob } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import type { ProcessorDepsEx } from './extended-deps.js';
import type { NewOutboxEvent } from '../db.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export async function processMaintenanceJob(
  job: JobLike<MaintenanceJob>,
  deps: ProcessorDepsEx,
): Promise<void> {
  await runIdempotentHandler({
    queue: 'maintenance',
    job,
    deps,
    work: async (ctx) => {
      const task = job.data.task;

      switch (task) {
        case 'prune-outbox': {
          const olderThan = new Date(
            Date.now() - SEVEN_DAYS_MS,
          ).toISOString();
          const outboxPruned = await deps.ops.transaction(async (tx) => {
            return deps.ops.pruneDoneOutbox(tx, olderThan);
          });
          const eventsPruned = await deps.ops.transaction(async (tx) => {
            return deps.ops.pruneHandledEvents(tx, olderThan);
          });
          ctx.log.info('Pruned outbox and events older than 7 days', { outboxPruned, eventsPruned });
          break;
        }

        case 'prune-events': {
          // Public SSE event retention (7 days) is enforced by the API lane's event store.
          // The worker only prunes its own tables (outbox and handled events).
          const olderThan = new Date(
            Date.now() - SEVEN_DAYS_MS,
          ).toISOString();
          const outboxPruned = await deps.ops.transaction(async (tx) => {
            return deps.ops.pruneDoneOutbox(tx, olderThan);
          });
          const eventsPruned = await deps.ops.transaction(async (tx) => {
            return deps.ops.pruneHandledEvents(tx, olderThan);
          });
          ctx.log.info('Pruned worker events older than 7 days', { outboxPruned, eventsPruned });
          break;
        }

        case 'clean-orphan-objects': {
          const olderThan = new Date(
            Date.now() - TWENTY_FOUR_HOURS_MS,
          ).toISOString();
          const staleKeys = await deps.storage.listStalePreparedObjects(
            'canonical/',
            olderThan,
          );
          if (staleKeys.length > 0) {
            await deps.storage.deleteObjects(staleKeys);
          }
          ctx.log.info('Cleaned orphan objects older than 24 hours', { count: staleKeys.length });
          break;
        }

        case 'reconcile-stragglers': {
          const receipts = await deps.receipts.transaction(async (tx) => {
            return deps.receipts.listReceiptsNeedingRecheck(tx, 50);
          });

          if (receipts.length > 0) {
            const outboxEvents: NewOutboxEvent[] = receipts.map((receipt) => ({
              aggregateType: 'receipt',
              aggregateId: `${receipt.subjectId}:${receipt.versionNumber}`,
              eventType: 'receipt.recheck.requested',
              payload: {
                subjectId: receipt.subjectId,
                versionNumber: receipt.versionNumber,
              },
            }));

            await deps.receipts.transaction(async (tx) => {
              await deps.outbox.insertOutboxEvents(tx, outboxEvents);
            });
          }

          ctx.log.info('Reconciled straggler receipts', { count: receipts.length });
          break;
        }

        default: {
          const _exhaustive: never = task;
          throw new Error(`Unknown maintenance task: ${_exhaustive}`);
        }
      }
    },
  });
}
