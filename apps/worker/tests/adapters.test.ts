/**
 * Adapter integration tests: prove the adapters delegate to the REAL lane
 * packages (not the deleted shims' throwers).
 *
 * - Solana: canonicalization output is byte-identical to calling
 *   @afterbyte/solana directly; submitAnchor without a signer throws the
 *   adapter's PublisherSigningUnavailableError (not a shim throw).
 * - Storage: unconfigured env -> createStorageAdapter() returns null
 *   (loud, honest) rather than a fake client.
 * - Research: unknown runId -> the adapter's own PermanentError; extract
 *   without MODEL_PROVIDER_KEY -> { providerUnavailable: true } from the
 *   real adapter path.
 */
import { describe, it, expect } from 'vitest';
import { createSolanaAdapter, PublisherSigningUnavailableError } from '../src/adapters/solana.js';
import { createStorageAdapter, storageConfigFromEnv } from '../src/adapters/storage.js';
import { createResearchAdapter } from '../src/adapters/research.js';
import { hashPayload, deriveObjectKey, HASH_SCHEMA_VERSION } from '@afterbyte/solana';
import { PermanentError } from '../src/errors.js';

function fakePool(rowsByMatch: Array<{ match: RegExp; rows: Record<string, unknown>[] }>) {
  return {
    query: async (sql: string) => {
      const hit = rowsByMatch.find((r) => r.match.test(sql));
      return { rows: hit ? hit.rows : [] };
    },
  } as never;
}

describe('solana adapter delegates to @afterbyte/solana', () => {
  it('canonicalizePublicationPayload matches the real package output', () => {
    const adapter = createSolanaAdapter();
    const payload = {
      schemaVersion: 1,
      subjectId: 'sub-1',
      versionNumber: 1,
      title: 'x',
    };
    const got = adapter.canonicalizePublicationPayload(payload);
    const expected = hashPayload(payload);
    expect(Buffer.from(got.canonicalBytes).toString('hex')).toBe(
      Buffer.from(expected.bytes).toString('hex'),
    );
    expect(got.payloadHash).toBe(expected.hex);
    expect(got.objectKey).toBe(deriveObjectKey(expected.hex));
    expect(got.hashSchemaVersion).toBe(HASH_SCHEMA_VERSION);
  });

  it('deriveReceiptAddress throws loudly without RECEIPT_PROGRAM_ID (no fake address)', async () => {
    const adapter = createSolanaAdapter();
    const saved = process.env.RECEIPT_PROGRAM_ID;
    delete process.env.RECEIPT_PROGRAM_ID;
    try {
      await expect(adapter.deriveReceiptAddress('sub-1', 1)).rejects.toThrow(/RECEIPT_PROGRAM_ID/);
    } finally {
      if (saved !== undefined) process.env.RECEIPT_PROGRAM_ID = saved;
    }
  });

  it('submitAnchor without a signer throws PublisherSigningUnavailableError', async () => {
    const adapter = createSolanaAdapter();
    await expect(
      adapter.submitAnchor('http://127.0.0.1:9', {
        subjectId: 'sub-1',
        versionNumber: 1,
        payloadHash: 'ab'.repeat(32),
        publicationKind: 'initial',
      }),
    ).rejects.toThrow(PublisherSigningUnavailableError);
  });
});

describe('storage adapter honest unconfigured behavior', () => {
  it('returns null config when object storage env is absent', () => {
    const saved = { ...process.env };
    for (const k of [
      'OBJECT_STORAGE_ENDPOINT',
      'STORAGE_ENDPOINT',
      'OBJECT_STORAGE_BUCKET_PUBLIC',
      'STORAGE_PUBLIC_BUCKET',
      'OBJECT_STORAGE_BUCKET_PRIVATE',
      'OBJECT_STORAGE_ACCESS_KEY',
      'OBJECT_STORAGE_SECRET_KEY',
    ]) {
      delete process.env[k];
    }
    try {
      expect(storageConfigFromEnv()).toBeNull();
      expect(createStorageAdapter()).toBeNull();
    } finally {
      process.env = saved;
    }
  });
});

describe('research adapter uses the real package path', () => {
  it('runDiscoveryStep on unknown run throws the adapter PermanentError', async () => {
    const adapter = createResearchAdapter({ pool: fakePool([]), storage: null });
    const err = await adapter
      .runDiscoveryStep('run_missing', { cancelled: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect((err as PermanentError).reason).toBe('research-run-not-found');
  });

  it('runExtractStep without MODEL_PROVIDER_KEY returns providerUnavailable', async () => {
    const snapshotRow = {
      snapshot_id: 'snap_1',
      run_id: 'run_1',
      source_id: 'src_1',
      provider_id: 'website',
      original_url: 'https://example.com',
      final_url: 'https://example.com/',
      status_code: 200,
      content_type: 'text/html',
      content_hash: 'ab'.repeat(32),
      bytes: 10,
      truncated: false,
      etag: null,
      last_modified: null,
      storage_key: null,
      excerpt: 'hello',
      fetched_at: new Date('2026-10-16T00:00:00Z'),
      error_code: null,
    };
    const adapter = createResearchAdapter({
      pool: fakePool([{ match: /research_snapshots/, rows: [snapshotRow] }]),
      storage: null,
    });
    const saved = process.env.MODEL_PROVIDER_KEY;
    delete process.env.MODEL_PROVIDER_KEY;
    try {
      const res = await adapter.runExtractStep('run_1', 'snap_1', { cancelled: false });
      expect(res.providerUnavailable).toBe(true);
    } finally {
      if (saved !== undefined) process.env.MODEL_PROVIDER_KEY = saved;
    }
  });

  it('registerRun writes through the real store', async () => {
    const inserted: Record<string, unknown>[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (/INSERT INTO research_runs/.test(sql)) {
          inserted.push({ run_id: params[0], subject_name: params[1] });
          return {
            rows: [
              {
                run_id: params[0],
                subject_name: params[1],
                subject_kind: params[2],
                aliases: [],
                known_urls: [],
                state: 'queued',
                caps: {},
                model_calls_used: 0,
                reserved_micros: 0,
                spent_micros: 0,
                steps: [],
                failure_code: null,
                failure_message: null,
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as never;
    const adapter = createResearchAdapter({ pool, storage: null });
    const runId = await adapter.registerRun({ subjectName: 'Example', subjectKind: 'website' });
    expect(runId).toMatch(/^run_/);
    expect(inserted[0]?.subject_name).toBe('Example');
  });
});
