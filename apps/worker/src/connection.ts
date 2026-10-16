/**
 * Redis connection factory (ADR-0001: BullMQ 5 + ioredis, Redis 7).
 *
 * BullMQ requires `maxRetriesPerRequest: null` and works best with
 * `enableReadyCheck: false` on the client it is given.
 */
import { Redis } from 'ioredis';

export interface RedisOptions {
  redisUrl: string;
}

let shared: Redis | null = null;

export function createRedisConnection(opts: RedisOptions): Redis {
  const redis = new Redis(opts.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Keep the worker alive across transient Redis blips; BullMQ retries.
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    lazyConnect: false,
  });
  redis.on('error', (err: Error) => {
    // Logged by the caller's logger; never throw from an event handler.
    console.error(JSON.stringify({ level: 'error', msg: 'redis error', err: String(err) }));
  });
  return redis;
}

/** Process-wide shared connection for queue producers (dispatcher, index). */
export function sharedConnection(redisUrl: string): Redis {
  if (!shared) shared = createRedisConnection({ redisUrl });
  return shared;
}

export async function closeSharedConnection(): Promise<void> {
  if (shared) {
    const c = shared;
    shared = null;
    await c.quit().catch(() => undefined);
  }
}
