/**
 * Reconciler: honest chain states, record-before-submit, idempotent retry,
 * RPC fallback. No fabricated transactions — the fake SolanaPackage is the
 * only chain the tests touch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  withRpcFallback,
  classifySignatureResult,
  anchorReceipt,
  recheckReceipt,
  ensureTransferSettled,
  type ReconcilerDeps,
} from '../src/reconciler.js';
import type { SolanaPackage } from '../src/adapters/solana.js';
import { MemReceiptStore } from '../src/fakes.js';
import { createLogger } from '../src/logging.js';
import { PermanentError } from '../src/errors.js';

const logger = createLogger({ test: 'reconciler' });

interface FakeChain {
  accounts: Map<string, { payloadHash: string; versionNumber: number }>;
  signatures: Map<string, { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; slot: number; err: unknown } | null>;
  submitted: string[];
  failSubmit: boolean;
}

function makeSolana(chain: FakeChain): SolanaPackage {
  return {
    canonicalizePublicationPayload: () => {
      throw new Error('not used here');
    },
    deriveReceiptAddress: async (subjectId: string, versionNumber: number) =>
      `receipt:${subjectId}:v${versionNumber}`,
    getReceiptAccount: async (_rpc: string, address: string) =>
      chain.accounts.get(address) ?? null,
    getSignatureStatus: async (_rpc: string, sig: string) => {
      if (!chain.signatures.has(sig)) return null;
      return chain.signatures.get(sig)!;
    },
    submitAnchor: async (_rpc: string, args: { subjectId: string; versionNumber: number; payloadHash: string }) => {
      if (chain.failSubmit) throw new Error('rpc timeout');
      const sig = `sig-${chain.submitted.length + 1}`;
      chain.submitted.push(sig);
      chain.signatures.set(sig, { confirmationStatus: 'processed', slot: 100, err: null });
      // Simulate the chain landing the receipt account on submit.
      chain.accounts.set(`receipt:${args.subjectId}:v${args.versionNumber}`, {
        payloadHash: args.payloadHash,
        versionNumber: args.versionNumber,
      });
      return { signature: sig };
    },
  };
}

function makeDeps(chain: FakeChain, store: MemReceiptStore, rpcUrls = ['https://rpc.primary']): ReconcilerDeps {
  return { receipts: store, solana: makeSolana(chain), rpcUrls, logger, now: () => '2026-10-16T10:00:00Z' };
}

const HASH = 'ab'.repeat(32);

describe('withRpcFallback', () => {
  it('tries the fallback when the primary fails', async () => {
    const calls: string[] = [];
    const result = await withRpcFallback(['https://a', 'https://b'], logger, async (url) => {
      calls.push(url);
      if (url === 'https://a') throw new Error('primary down');
      return 'ok-from-b';
    });
    expect(result).toBe('ok-from-b');
    expect(calls).toEqual(['https://a', 'https://b']);
  });

  it('throws TransientError listing all failures when every RPC fails', async () => {
    await expect(
      withRpcFallback(['https://a'], logger, async () => {
        throw new Error('down');
      }),
    ).rejects.toThrow(/All RPCs failed.*https:\/\/a/);
  });
});

describe('classifySignatureResult', () => {
  it('maps chain states honestly', () => {
    expect(classifySignatureResult(null).state).toBe('unknown');
    expect(classifySignatureResult({ confirmationStatus: 'finalized', slot: 1, err: null }).state).toBe('finalized');
    expect(classifySignatureResult({ confirmationStatus: 'confirmed', slot: 1, err: null }).state).toBe('confirmed');
    expect(classifySignatureResult({ confirmationStatus: 'processed', slot: 1, err: null }).state).toBe('pending');
    expect(classifySignatureResult({ confirmationStatus: 'finalized', slot: 1, err: { InstructionError: 1 } }).state).toBe('failed');
  });
});

describe('anchorReceipt', () => {
  let chain: FakeChain;
  let store: MemReceiptStore;
  beforeEach(() => {
    chain = { accounts: new Map(), signatures: new Map(), submitted: [], failSubmit: false };
    store = new MemReceiptStore();
  });

  it('records the tx attempt BEFORE submitting', async () => {
    const deps = makeDeps(chain, store);
    const order: string[] = [];
    const origSubmit = deps.solana.submitAnchor;
    deps.solana.submitAnchor = async (...args) => {
      order.push('submit');
      return origSubmit(...args);
    };
    const origRecord = store.recordTxAttempt.bind(store);
    store.recordTxAttempt = (async (tx: never, attempt: never) => {
      order.push('record');
      return origRecord(tx, attempt);
    }) as typeof store.recordTxAttempt;

    const outcome = await anchorReceipt(deps, { subjectId: 's1', versionNumber: 1, payloadHash: HASH });
    expect(outcome.status).toBe('submitted');
    expect(order).toEqual(['record', 'submit']);
    const attempts = await store.transaction((tx) => store.listAttemptsForReceipt(tx, 's1', 1));
    expect(attempts).toHaveLength(1);
    // The attempt row carries the real signature so rechecks can find it.
    expect(attempts[0].signature).toBe(chain.submitted[0]);
    expect(outcome.signature).toBe(chain.submitted[0]);
  });

  it('reports unavailable when no RPC is configured (no fabrication)', async () => {
    const deps = makeDeps(chain, store, []);
    const outcome = await anchorReceipt(deps, { subjectId: 's1', versionNumber: 1, payloadHash: HASH });
    expect(outcome.status).toBe('unavailable');
    expect(chain.submitted).toHaveLength(0);
    const receipt = await store.transaction((tx) => store.getReceipt(tx, 's1', 1));
    expect(receipt?.status).toBe('unavailable');
  });

  it('treats an already-existing receipt with the same hash as success (no resubmit)', async () => {
    chain.accounts.set('receipt:s1:v1', { payloadHash: HASH, versionNumber: 1 });
    const deps = makeDeps(chain, store);
    const outcome = await anchorReceipt(deps, { subjectId: 's1', versionNumber: 1, payloadHash: HASH });
    expect(outcome.status).toBe('finalized');
    expect(chain.submitted).toHaveLength(0);
  });

  it('fails loudly on payload conflict (different hash, same version)', async () => {
    chain.accounts.set('receipt:s1:v1', { payloadHash: 'ff'.repeat(32), versionNumber: 1 });
    const deps = makeDeps(chain, store);
    await expect(
      anchorReceipt(deps, { subjectId: 's1', versionNumber: 1, payloadHash: HASH }),
    ).rejects.toBeInstanceOf(PermanentError);
    const receipt = await store.transaction((tx) => store.getReceipt(tx, 's1', 1));
    expect(receipt?.status).toBe('failed');
    expect(chain.submitted).toHaveLength(0);
  });

  it('does not mark failed on submit timeout — the recheck resolves it', async () => {
    chain.failSubmit = true;
    const deps = makeDeps(chain, store);
    await expect(
      anchorReceipt(deps, { subjectId: 's1', versionNumber: 1, payloadHash: HASH }),
    ).rejects.toThrow();
    const attempts = await store.transaction((tx) => store.listAttemptsForReceipt(tx, 's1', 1));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('submitted'); // unknown outcome, NOT failed
  });
});

describe('recheckReceipt', () => {
  let chain: FakeChain;
  let store: MemReceiptStore;
  beforeEach(() => {
    chain = { accounts: new Map(), signatures: new Map(), submitted: [], failSubmit: false };
    store = new MemReceiptStore();
  });

  it('finalizes when the signature reaches finalized', async () => {
    const deps = makeDeps(chain, store);
    await anchorReceipt(deps, { subjectId: 's1', versionNumber: 1, payloadHash: HASH });
    const sig = chain.submitted[0];
    chain.signatures.set(sig, { confirmationStatus: 'finalized', slot: 101, err: null });
    const outcome = await recheckReceipt(deps, { subjectId: 's1', versionNumber: 1 });
    expect(outcome).toMatchObject({ status: 'finalized', changed: true });
    const receipt = await store.transaction((tx) => store.getReceipt(tx, 's1', 1));
    expect(receipt?.status).toBe('finalized');
    expect(receipt?.finalizedAt).toBe('2026-10-16T10:00:00Z');
  });

  it('recognizes a landed receipt account even when the signature is unknown', async () => {
    const deps = makeDeps(chain, store);
    await anchorReceipt(deps, { subjectId: 's1', versionNumber: 1, payloadHash: HASH });
    // Signature dropped from node history; receipt account exists with same hash.
    chain.signatures.delete(chain.submitted[0]);
    const outcome = await recheckReceipt(deps, { subjectId: 's1', versionNumber: 1 });
    expect(outcome.status).toBe('finalized');
  });
});

describe('ensureTransferSettled', () => {
  let chain: FakeChain;
  let store: MemReceiptStore;
  beforeEach(() => {
    chain = { accounts: new Map(), signatures: new Map(), submitted: [], failSubmit: false };
    store = new MemReceiptStore();
  });

  it('reports settled only on finalized success', async () => {
    const deps = makeDeps(chain, store);
    chain.signatures.set('sig-ok', { confirmationStatus: 'finalized', slot: 5, err: null });
    const r = await ensureTransferSettled(deps, { kind: 'payment', referenceId: 'intent-1', priorSignature: 'sig-ok' });
    expect(r).toMatchObject({ settled: true, status: 'finalized' });
  });

  it('refuses to clear a second transfer while the first is confirmed-but-not-final', async () => {
    const deps = makeDeps(chain, store);
    chain.signatures.set('sig-mid', { confirmationStatus: 'confirmed', slot: 5, err: null });
    const r = await ensureTransferSettled(deps, { kind: 'refund', referenceId: 'ref-1', priorSignature: 'sig-mid' });
    expect(r.settled).toBe(false);
    expect(r.status).toBe('confirmed');
  });

  it('reports unknown honestly when the signature is indeterminate', async () => {
    const deps = makeDeps(chain, store);
    const r = await ensureTransferSettled(deps, { kind: 'payment', referenceId: 'intent-2', priorSignature: 'sig-gone' });
    expect(r).toMatchObject({ settled: false, status: 'unknown' });
  });

  it('reports none when there is no prior signature', async () => {
    const deps = makeDeps(chain, store);
    const r = await ensureTransferSettled(deps, { kind: 'payment', referenceId: 'intent-3', priorSignature: null });
    expect(r).toMatchObject({ settled: false, status: 'none' });
  });
});
