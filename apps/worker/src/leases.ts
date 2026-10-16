/**
 * Leases + cancellation for long-running steps (brief §8).
 *
 * A lease is a Postgres row; heartbeats extend it. Cancellation is a flag
 * on the job record, checked between steps.
 */
import type { LeaseStore, OutboxStore } from './db.js';
import type { Logger } from './logging.js';
import { PermanentError, TransientError } from './errors.js';

export interface LeaseHandle {
  heartbeat(): Promise<boolean>;
}

export async function withLease(
  leaseStore: LeaseStore,
  leaseKey: string,
  owner: string,
  ttlMs: number,
  logger: Logger,
  fn: (lease: LeaseHandle) => Promise<void>,
): Promise<void> {
  const now = () => new Date().toISOString();
  const lease = await leaseStore.transaction((tx) =>
    leaseStore.acquireLease(tx, leaseKey, owner, ttlMs, now()),
  );
  if (!lease) {
    throw new TransientError(`lease busy: ${leaseKey}`);
  }

  const heartbeat = async (): Promise<boolean> => {
    try {
      return await leaseStore.transaction((tx) =>
        leaseStore.heartbeatLease(tx, leaseKey, owner, ttlMs, now()),
      );
    } catch (err) {
      logger.warn('lease heartbeat failed', { err: String(err), leaseKey });
      return false;
    }
  };

  const timer = setInterval(() => {
    void heartbeat();
  }, Math.max(1000, Math.floor(ttlMs / 3)));
  // Don't hold the process open for the heartbeat timer alone.
  if (typeof timer.unref === 'function') timer.unref();

  try {
    await fn({ heartbeat });
  } finally {
    clearInterval(timer);
    try {
      await leaseStore.transaction((tx) => leaseStore.releaseLease(tx, leaseKey, owner));
    } catch (err) {
      logger.warn('lease release failed', { err: String(err), leaseKey });
    }
  }
}

export interface CancellationToken {
  throwIfCancelled(): Promise<void>;
}

export function createCancellationToken(
  outbox: OutboxStore,
  jobKey: string,
): CancellationToken {
  return {
    async throwIfCancelled(): Promise<void> {
      const record = await outbox.transaction((tx) => outbox.getJobRecord(tx, jobKey));
      if (!record) return;
      if (record.cancelled === true || record.status === 'cancelled') {
        throw new PermanentError('job-cancelled', `job ${jobKey} was cancelled`);
      }
    },
  };
}

export const checkCancelled = createCancellationToken;
