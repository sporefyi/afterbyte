import { createHash } from 'node:crypto';
import type { JobLike } from './deps.js';
import type { PublishJob } from '../queues.js';
import { jobKeys } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import { PermanentError, TransientError } from '../errors.js';
import type { ProcessorDepsEx } from './extended-deps.js';
import type { NewOutboxEvent } from '../db.js';

export async function processPublishJob(
  job: JobLike<PublishJob>,
  deps: ProcessorDepsEx,
): Promise<void> {
  await runIdempotentHandler({
    queue: 'publish',
    job,
    deps,
    work: async (ctx) => {
      const { subjectId, versionNumber, draftId } = job.data;
      // (a) Load draft
      const draft = await deps.publish.transaction(async (tx) => {
        return deps.publish.getDraftForPublish(tx, draftId);
      });

      if (!draft) {
        throw new PermanentError('draft-not-found', `Draft ${draftId} not found`);
      }

      // (b) Idempotency check
      const versionAlreadyExists = await deps.publish.transaction(async (tx) => {
        return deps.publish.versionExists(tx, subjectId, versionNumber);
      });

      if (versionAlreadyExists) {
        ctx.log.info('Version already published (idempotent delivery)', { subjectId, versionNumber });
        return;
      }

      // (c) Canonicalize payload
      // NEVER reimplement canonicalization — delegated to solana package
      const { canonicalBytes, payloadHash, objectKey } =
        deps.solana.canonicalizePublicationPayload(draft.payload);

      // The on-chain receipt instruction encodes the publication kind; the
      // canonical payload is required to carry it (ADR-0002).
      const publicationKind = draft.payload.publicationKind;
      if (
        publicationKind !== 'initial' &&
        publicationKind !== 'amendment' &&
        publicationKind !== 'correction' &&
        publicationKind !== 'retraction'
      ) {
        throw new PermanentError(
          'draft-missing-publication-kind',
          `Draft ${draftId} payload has no valid publicationKind`,
        );
      }

      // (d) Store canonical bytes and verify digest
      await deps.storage.putObject(objectKey, canonicalBytes, 'application/json');

      const storedBytes = await deps.storage.getObject(objectKey);
      const digest = createHash('sha256').update(storedBytes).digest('hex');

      if (digest !== payloadHash) {
        // Best-effort cleanup
        try {
          await deps.storage.deleteObjects([objectKey]);
        } catch (err) {
          ctx.log.warn('Failed to clean up mismatched object', { objectKey, err });
        }
        throw new PermanentError(
          'canonical-digest-mismatch',
          `Stored digest ${digest} does not match expected ${payloadHash}`,
        );
      }

      // (e) Commit publication with outbox events
      const publishedAt = ctx.now();
      const outboxEvents: NewOutboxEvent[] = [
        {
          aggregateType: 'receipt',
          aggregateId: `${subjectId}:${versionNumber}`,
          eventType: 'receipt.anchor.requested',
          payload: {
            subjectId,
            versionNumber,
            payloadHash,
            publicationKind,
            jobKey: jobKeys.anchorReceipt(subjectId, versionNumber),
          },
        },
        {
          aggregateType: 'readmodel',
          aggregateId: 'all',
          eventType: 'readmodel.refresh.requested',
          payload: {
            scope: 'all',
            jobKey: jobKeys.refreshReadModels('all', publishedAt),
          },
        },
        {
          aggregateType: 'sharecard',
          aggregateId: `${subjectId}:${versionNumber}`,
          eventType: 'sharecard.render.requested',
          payload: {
            subjectId,
            versionNumber,
            jobKey: jobKeys.renderShareCard(subjectId, versionNumber),
          },
        },
        {
          aggregateType: 'dossier',
          aggregateId: subjectId,
          eventType: 'dossier.published',
          payload: { subjectId, versionNumber },
        },
      ];

      try {
        await deps.publish.transaction(async (tx) => {
          await deps.publish.commitPublication(tx, {
            draft,
            canonicalBytes,
            payloadHash,
            objectKey,
            publishedAt,
            outboxEvents,
          });
        });
      } catch (err) {
        // (f) Best-effort orphan cleanup if commit fails after putObject
        try {
          await deps.storage.deleteObjects([objectKey]);
        } catch (cleanupErr) {
          ctx.log.warn('Failed to clean up orphaned object after commit failure', { objectKey, cleanupErr });
        }
        throw err;
      }

      ctx.log.info('Publication committed', { subjectId, versionNumber, objectKey });
    },
  });
}
