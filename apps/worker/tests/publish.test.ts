/**
 * Publish flow (brief §9): canonicalize → object write + digest verify →
 * ONE transaction (immutable version + current pointer + outbox events).
 * Canonicalization itself is the Solana lane's job — here it is faked.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { processPublishJob } from '../src/processors/publish.js';
import type { ProcessorDepsEx } from '../src/processors/extended-deps.js';
import { MemOutboxStore, MemPublishStore, MemReceiptStore, MemReadModelStore, MemOpsStore } from '../src/fakes.js';
import { createLogger } from '../src/logging.js';
import { UnrecoverableError } from 'bullmq';
import type { DossierVersionDraft } from '../src/types.js';

const HASH = createHash('sha256').update('canonical-bytes').digest('hex');

function makeDraft(): DossierVersionDraft {
  return {
    subjectId: 'sub-1',
    versionNumber: 1,
    draftId: 'draft-1',
    previousPayloadHash: '00'.repeat(32),
    payload: { schemaVersion: 1, title: 'Test dossier', publicationKind: 'initial' },
  };
}

function makeDeps() {
  const outbox = new MemOutboxStore();
  const publish = new MemPublishStore();
  publish.drafts.set('draft-1', makeDraft());
  const objects = new Map<string, Uint8Array>();
  const storage = {
    putObject: async (key: string, bytes: Uint8Array, _ct: string) => {
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
    getObject: async (key: string) => {
      const b = objects.get(key);
      if (!b) throw new Error('not found');
      return b;
    },
    headObject: async (key: string) => {
      const b = objects.get(key);
      return b ? { size: b.length } : null;
    },
    deleteObjects: async (keys: string[]) => {
      for (const k of keys) objects.delete(k);
    },
    listStalePreparedObjects: async () => [] as string[],
  };
  const solana = {
    canonicalizePublicationPayload: (_payload: Record<string, unknown>) => ({
      canonicalBytes: new TextEncoder().encode('canonical-bytes'),
      payloadHash: HASH,
      objectKey: `canonical/${HASH}.json`,
      hashSchemaVersion: 1,
    }),
    deriveReceiptAddress: async () => 'receipt-addr',
    getReceiptAccount: async () => null,
    getSignatureStatus: async () => null,
    submitAnchor: async () => ({ signature: 'sig' }),
  };
  const deps = {
    outbox,
    research: {},
    logger: createLogger({ test: 'publish' }),
    workerId: 'test-worker',
    publish,
    receipts: new MemReceiptStore(),
    readmodels: new MemReadModelStore(),
    ops: new MemOpsStore(),
    storage,
    solana,
    rpcUrls: [],
    paymentsEnabled: false,
  } as unknown as ProcessorDepsEx;
  return { deps, publish, outbox, objects };
}

function publishJob(jobKey = 'publish:sub-1:v1', attemptsMade = 0) {
  return {
    data: { schemaVersion: 1 as const, jobKey, subjectId: 'sub-1', versionNumber: 1, draftId: 'draft-1' },
    attemptsMade,
  };
}

describe('processPublishJob', () => {
  it('commits version + pointer + outbox events, and verifies the digest', async () => {
    const { deps, publish, outbox, objects } = makeDeps();
    await processPublishJob(publishJob(), deps);

    expect(publish.versions).toHaveLength(1);
    expect(publish.versions[0]).toMatchObject({
      subjectId: 'sub-1',
      versionNumber: 1,
      payloadHash: HASH,
      objectKey: `canonical/${HASH}.json`,
    });
    expect(publish.currentPointer.get('sub-1')).toBe(1);
    // Object was written and its digest verified.
    const stored = objects.get(`canonical/${HASH}.json`);
    expect(stored).toBeDefined();
    expect(createHash('sha256').update(stored!).digest('hex')).toBe(HASH);
    // Follow-up outbox events for the pipeline (written by the publish
    // store in the same transaction as the version commit).
    const types = [...publish.outbox.events.values()].map((e) => e.eventType);
    expect(types).toContain('receipt.anchor.requested');
    expect(types).toContain('readmodel.refresh.requested');
    expect(types).toContain('sharecard.render.requested');
    expect(types).toContain('dossier.published');
  });

  it('is idempotent: a duplicate delivery does not create a second version', async () => {
    const { deps, publish } = makeDeps();
    await processPublishJob(publishJob(), deps);
    await processPublishJob(publishJob(), deps);
    expect(publish.versions).toHaveLength(1);
  });

  it('fails permanently when the draft is missing', async () => {
    const { deps } = makeDeps();
    const job = {
      data: { schemaVersion: 1 as const, jobKey: 'publish:sub-1:v9', subjectId: 'sub-1', versionNumber: 9, draftId: 'nope' },
      attemptsMade: 0,
    };
    await expect(processPublishJob(job, deps)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('fails permanently and cleans up the orphan object on digest mismatch', async () => {
    const { deps, objects } = makeDeps();
    // Corrupt the stored bytes after write so the digest check fails.
    const origGet = deps.storage.getObject;
    deps.storage.getObject = async (key: string) => {
      const b = await origGet(key);
      const corrupted = new Uint8Array(b);
      corrupted[0] ^= 0xff;
      return corrupted;
    };
    await expect(processPublishJob(publishJob(), deps)).rejects.toThrow(UnrecoverableError);
    await expect(processPublishJob(publishJob(), deps)).rejects.toThrow(/canonical-digest-mismatch/);
    expect(objects.has(`canonical/${HASH}.json`)).toBe(false);
  });
});
