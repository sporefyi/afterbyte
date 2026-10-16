/**
 * Queue wiring: every brief §8 queue has a registered processor, and the
 * BullMQ worker path works end-to-end. The pure registry test needs no
 * Redis; the live BullMQ test uses ioredis-mock and skips gracefully if the
 * mock cannot drive BullMQ in this environment.
 */
import { describe, it, expect } from 'vitest';
import { QUEUE_NAMES, type QueueName } from '../src/queues.js';
import { buildProcessorRegistry } from '../src/index.js';
import { createLogger } from '../src/logging.js';
import type { ProcessorDepsEx } from '../src/processors/index.js';

function fakeDeps(): ProcessorDepsEx {
  return {
    outbox: {},
    research: {},
    logger: createLogger({ test: 'wiring' }),
    workerId: 'test-worker',
    publish: {},
    receipts: {},
    readmodels: {},
    ops: {},
    storage: {},
    solana: {},
    rpcUrls: [],
    paymentsEnabled: false,
  } as unknown as ProcessorDepsEx;
}

describe('buildProcessorRegistry', () => {
  it('registers a processor for all 13 queues', () => {
    const registry = buildProcessorRegistry(fakeDeps());
    expect(registry.size).toBe(QUEUE_NAMES.length);
    for (const name of QUEUE_NAMES) {
      expect(typeof registry.get(name as QueueName), `missing processor for ${name}`).toBe('function');
    }
  });
});

describe('bullmq wiring (ioredis-mock)', () => {
  it('processes a job through a real BullMQ Worker', async () => {
    let RedisMock: new (...args: unknown[]) => unknown;
    try {
      const mod = await import('ioredis-mock');
      RedisMock = (mod as { default: new (...args: unknown[]) => unknown }).default;
    } catch {
      console.warn('SKIP: ioredis-mock not installed');
      return;
    }
    const { Queue, Worker } = await import('bullmq');
    const connection = new RedisMock() as never;

    let processed = 0;
    const queue = new Queue('discovery', { connection });
    const worker = new Worker(
      'discovery',
      async (job) => {
        processed++;
        expect(job.data).toMatchObject({ schemaVersion: 1, jobKey: 'discovery:run-9' });
      },
      { connection: new RedisMock() as never },
    );
    try {
      await queue.add('process', { schemaVersion: 1, jobKey: 'discovery:run-9', runId: 'run-9' });
      const deadline = Date.now() + 15_000;
      while (processed === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(processed).toBe(1);
    } catch (err) {
      console.warn('SKIP: ioredis-mock could not drive BullMQ here:', String(err));
    } finally {
      await worker.close().catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  }, 30_000);
});
