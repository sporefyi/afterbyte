/** Leases + cancellation tokens for long steps (brief §8). */
import { describe, it, expect, beforeEach } from 'vitest';
import { withLease, createCancellationToken } from '../src/leases.js';
import { MemLeaseStore, MemOutboxStore } from '../src/fakes.js';
import { createLogger } from '../src/logging.js';
import { PermanentError, TransientError } from '../src/errors.js';

const logger = createLogger({ test: 'leases' });

describe('withLease', () => {
  let store: MemLeaseStore;
  beforeEach(() => {
    store = new MemLeaseStore();
  });

  it('acquires, heartbeats, and releases the lease', async () => {
    let heartbeats = 0;
    await withLease(store, 'lease-1', 'owner-a', 60_000, logger, async (lease) => {
      const ok = await lease.heartbeat();
      expect(ok).toBe(true);
      heartbeats++;
      const row = await store.transaction((tx) => store.getLease(tx, 'lease-1'));
      expect(row?.owner).toBe('owner-a');
    });
    expect(heartbeats).toBe(1);
    expect(await store.transaction((tx) => store.getLease(tx, 'lease-1'))).toBeNull();
  });

  it('refuses when another owner holds a live lease', async () => {
    const now = new Date().toISOString();
    await store.transaction((tx) => store.acquireLease(tx, 'lease-2', 'owner-a', 60_000, now));
    await expect(
      withLease(store, 'lease-2', 'owner-b', 60_000, logger, async () => undefined),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it('releases the lease even when the work throws', async () => {
    await expect(
      withLease(store, 'lease-3', 'owner-a', 60_000, logger, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(await store.transaction((tx) => store.getLease(tx, 'lease-3'))).toBeNull();
  });
});

describe('createCancellationToken', () => {
  it('throws PermanentError when the job was cancelled', async () => {
    const store = new MemOutboxStore();
    const now = new Date().toISOString();
    await store.transaction(async (tx) => {
      await store.ensureJobRecord(tx, 'k-1', 'fetch', now);
      await store.cancelJob(tx, 'k-1');
    });
    const token = createCancellationToken(store, 'k-1');
    await expect(token.throwIfCancelled()).rejects.toBeInstanceOf(PermanentError);
  });

  it('is a no-op for live or unknown jobs', async () => {
    const store = new MemOutboxStore();
    const token = createCancellationToken(store, 'k-unknown');
    await expect(token.throwIfCancelled()).resolves.toBeUndefined();
  });
});
