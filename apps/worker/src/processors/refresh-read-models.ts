import type { JobLike } from './deps.js';
import type { RefreshReadModelsJob } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import { refreshAllReadModels } from '../readmodels.js';
import type { ProcessorDepsEx } from './extended-deps.js';

export async function processRefreshReadModelsJob(
  job: JobLike<RefreshReadModelsJob>,
  deps: ProcessorDepsEx,
): Promise<void> {
  await runIdempotentHandler({
    queue: 'refresh-read-models',
    job,
    deps,
    work: async (ctx) => {
      const result = await refreshAllReadModels(
        deps.readmodels,
        ctx.log,
        job.data.scope,
        ctx.now,
      );

      ctx.log.info('Read models refreshed', {
        refreshed: result.refreshed,
        sourceRevision: result.sourceRevision,
      });
    },
  });
}
