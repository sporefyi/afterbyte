/**
 * AFTERBYTE worker entrypoint.
 *
 * Boots 13 BullMQ workers (one per queue, brief §8), the outbox dispatcher,
 * crash recovery, a worker heartbeat, and graceful shutdown.
 *
 * Startup fails LOUD when core config is missing. Optional capabilities
 * (Solana RPC, storage, research, payments) degrade honestly: jobs needing
 * them throw clear errors instead of fabricating results (ADR-0003).
 */
import { Worker, Queue } from 'bullmq';
import type { QueueName } from './queues.js';
import { QUEUE_NAMES, jobKeys } from './queues.js';
import { loadConfig, type WorkerConfig } from './config.js';
import { createLogger, type Logger } from './logging.js';
import { createRedisConnection, closeSharedConnection, sharedConnection } from './connection.js';
import { afterbyteBackoffStrategy, defaultJobOptions } from './backoff.js';
import { dispatchOutboxTick, reconcileOutboxAfterCrash } from './outbox.js';
import { createPgStores, type PgStores } from './pg.js';
import type { ProcessorDepsEx } from './processors/index.js';
import {
  processDiscoveryJob,
  processFetchJob,
  processExtractJob,
  processDraftJob,
  processReviewPreflightJob,
  processPublishJob,
  processAnchorReceiptJob,
  processRecheckReceiptJob,
  processRefreshReadModelsJob,
  processRenderShareCardJob,
  processReconcilePaymentJob,
  processReconcileRefundJob,
  processMaintenanceJob,
} from './processors/index.js';
import type { SolanaPackage } from './adapters/solana.js';
import { createSolanaAdapter } from './adapters/solana.js';
import type { ResearchPackage } from './adapters/research.js';
import { createResearchAdapter } from './adapters/research.js';
import type { StoragePackage } from './adapters/storage.js';
import { createStorageAdapter } from './adapters/storage.js';

const CONCURRENCY: Record<QueueName, number> = {
  discovery: 5,
  fetch: 5,
  extract: 5,
  draft: 3,
  'review-preflight': 3,
  // Publication + anchoring are serialized: version N+1 waits for N (brief §10),
  // and publish commits are single-writer by design.
  publish: 1,
  'anchor-receipt': 1,
  'recheck-receipt': 1,
  'refresh-read-models': 2,
  'render-share-card': 3,
  'reconcile-payment': 1,
  'reconcile-refund': 1,
  maintenance: 1,
};

const PROCESSORS: Record<QueueName, (job: any, deps: ProcessorDepsEx) => Promise<void>> = {
  discovery: processDiscoveryJob,
  fetch: processFetchJob,
  extract: processExtractJob,
  draft: processDraftJob,
  'review-preflight': processReviewPreflightJob,
  publish: processPublishJob,
  'anchor-receipt': processAnchorReceiptJob,
  'recheck-receipt': processRecheckReceiptJob,
  'refresh-read-models': processRefreshReadModelsJob,
  'render-share-card': processRenderShareCardJob,
  'reconcile-payment': processReconcilePaymentJob,
  'reconcile-refund': processReconcileRefundJob,
  maintenance: processMaintenanceJob,
};

/**
 * Loud placeholder for a capability whose package (or configuration) is not
 * available. The worker boots fine; only jobs that actually need the
 * capability fail, loudly and honestly.
 */
function notYet<T>(packageName: string, importPath: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return (..._args: unknown[]) => {
          throw new Error(
            `[${packageName} shim] not yet implemented — replace ${importPath} ` +
              `with the real package import. Accessed: ${String(prop)}`,
          );
        };
      },
    },
  ) as T;
}

export function buildProcessorRegistry(
  deps: ProcessorDepsEx,
): Map<QueueName, (job: any) => Promise<void>> {
  const registry = new Map<QueueName, (job: any) => Promise<void>>();
  for (const queueName of QUEUE_NAMES) {
    const processor = PROCESSORS[queueName];
    registry.set(queueName, (job) => processor(job, deps));
  }
  return registry;
}

function buildDeps(config: WorkerConfig, logger: Logger, stores: PgStores): ProcessorDepsEx {
  const rpcUrls = [config.solanaRpcUrl, config.solanaRpcFallbackUrl].filter(
    (u): u is string => u !== null,
  );
  if (rpcUrls.length === 0) {
    logger.warn('no SOLANA_RPC_URL configured — receipt anchoring will report unavailable');
  }
  const storageAdapter = createStorageAdapter();
  if (!storageAdapter) {
    logger.warn('object storage not configured — storage-backed steps will fail loudly, not fabricate');
  }
  return {
    outbox: stores.outbox,
    research: createResearchAdapter({ pool: stores.pool, storage: storageAdapter, logger }),
    logger,
    workerId: config.workerId,
    publish: stores.publish,
    receipts: stores.receipts,
    readmodels: stores.readmodels,
    ops: stores.ops,
    storage: storageAdapter ?? notYet<StoragePackage>('@afterbyte/storage', 'src/adapters/storage.ts'),
    solana: createSolanaAdapter({ logger }),
    rpcUrls,
    paymentsEnabled: config.paymentsEnabled,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ workerId: config.workerId });
  const startedAt = new Date().toISOString();

  logger.info('worker starting', {
    appEnv: config.appEnv,
    workerId: config.workerId,
    paymentsEnabled: config.paymentsEnabled,
    tokenEnabled: config.tokenEnabled,
    solanaRpcConfigured: config.solanaRpcUrl !== null,
    storageConfigured: config.storageEndpoint !== null,
  });

  const stores = createPgStores(config.databaseUrl);
  const deps = buildDeps(config, logger, stores);

  // Fail fast with a clear error when dependencies are unreachable —
  // better than a cryptic AggregateError deep in BullMQ.
  try {
    await stores.pool.query('SELECT 1');
  } catch (err) {
    throw new Error(`[worker startup] cannot reach Postgres (DATABASE_URL): ${String(err)}`);
  }
  const queueConnection = sharedConnection(config.redisUrl);
  try {
    await queueConnection.ping();
  } catch (err) {
    throw new Error(`[worker startup] cannot reach Redis (REDIS_URL): ${String(err)}`);
  }

  // Queues share one connection; each Worker gets its own (BullMQ requirement
  // for blocking clients).
  const queues = new Map<QueueName, Queue>();
  for (const queueName of QUEUE_NAMES) {
    queues.set(queueName, new Queue(queueName, { connection: queueConnection }));
  }

  const registry = buildProcessorRegistry(deps);
  const workers: Worker[] = [];
  for (const queueName of QUEUE_NAMES) {
    const worker = new Worker(
      queueName,
      async (job) => {
        const processor = registry.get(queueName);
        if (!processor) throw new Error(`no processor registered for queue ${queueName}`);
        return processor(job);
      },
      {
        connection: createRedisConnection({ redisUrl: config.redisUrl }),
        concurrency: CONCURRENCY[queueName],
        settings: { backoffStrategy: afterbyteBackoffStrategy },
      },
    );
    worker.on('failed', (job, err) => {
      logger.error('job failed', {
        queue: queueName,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        failedReason: err?.message,
      });
    });
    worker.on('error', (err) => {
      logger.error('worker error', { queue: queueName, error: String(err) });
    });
    workers.push(worker);
  }

  // Crash recovery before accepting new work: redeliver stuck outbox events,
  // mark stranded running jobs interrupted.
  const recovered = await reconcileOutboxAfterCrash(stores.outbox, logger, {
    stuckAfterSec: config.outboxStuckAfterSec,
  });
  logger.info('crash recovery complete', { ...recovered });

  // Schedule the periodic straggler-reconciliation maintenance job.
  const maintenanceQueue = queues.get('maintenance');
  if (maintenanceQueue) {
    await maintenanceQueue.add(
      'scheduled',
      {
        schemaVersion: 1 as const,
        jobKey: jobKeys.maintenance('reconcile-stragglers'),
        task: 'reconcile-stragglers',
      },
      { ...defaultJobOptions('maintenance:reconcile-stragglers'), repeat: { every: 5 * 60_000 } },
    );
  }

  // Outbox dispatcher tick (overlap-guarded).
  let dispatchInFlight = false;
  const dispatchTimer = setInterval(() => {
    if (dispatchInFlight) return;
    dispatchInFlight = true;
    dispatchOutboxTick({ store: stores.outbox, queues, logger, batchSize: 100 })
      .then((stats) => {
        if (stats.claimed > 0) logger.info('outbox dispatch tick', { ...stats });
      })
      .catch((err) => logger.error('outbox dispatch tick failed', { error: String(err) }))
      .finally(() => {
        dispatchInFlight = false;
      });
  }, config.outboxPollIntervalSec * 1000);

  // Worker heartbeat (brief §8).
  const heartbeatTimer = setInterval(() => {
    const now = new Date().toISOString();
    stores.ops
      .transaction((tx) =>
        stores.ops.upsertWorkerHeartbeat(tx, {
          workerId: config.workerId,
          queues: [...QUEUE_NAMES],
          startedAt,
          now,
        }),
      )
      .catch((err) => logger.warn('heartbeat write failed', { error: String(err) }));
  }, config.heartbeatIntervalSec * 1000);

  // Graceful shutdown: stop timers, drain workers, close connections.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown initiated', { signal });
    clearInterval(dispatchTimer);
    clearInterval(heartbeatTimer);

    const forceTimer = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 30_000);
    forceTimer.unref();

    try {
      await Promise.all(workers.map((w) => w.close()));
      for (const queue of queues.values()) await queue.close();
      await stores.pool.end().catch(() => undefined);
      await closeSharedConnection();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('shutdown error', { error: String(err) });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('worker ready', { queues: QUEUE_NAMES.length });
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(
      JSON.stringify({ level: 'fatal', msg: 'worker failed to start', err: String(err) }),
    );
    process.exit(1);
  });
}

export const __testables = { buildProcessorRegistry, buildDeps, PROCESSORS, CONCURRENCY };
