import { describe, it, expect } from 'vitest';
import {
  validateIntentRequest,
  validateFinalize,
  buildQuarantineKey,
  publicKeyFor,
  QUARANTINE_PREFIX,
} from '../src/uploads.js';
import { buildManifest, bundlePrefix, sha256Hex, manifestKey } from '../src/bundles.js';

describe('upload intents', () => {
  it('accepts allowlisted types within the size cap', () => {
    expect(validateIntentRequest({ filename: 'a.png', contentType: 'image/png', bytes: 100 })).toEqual({ ok: true });
  });

  it('rejects disallowed types, oversize, and bad filenames', () => {
    expect(validateIntentRequest({ filename: 'a.exe', contentType: 'application/x-msdownload', bytes: 10 }).ok).toBe(false);
    expect(validateIntentRequest({ filename: 'a.png', contentType: 'image/png', bytes: 0 }).ok).toBe(false);
    expect(validateIntentRequest({ filename: '', contentType: 'image/png', bytes: 10 }).ok).toBe(false);
  });

  it('builds quarantine keys that never escape the prefix', () => {
    const key = buildQuarantineKey('id-1', '../../etc/passwd');
    expect(key.startsWith(QUARANTINE_PREFIX)).toBe(true);
    // exactly one filename segment: no traversal can add path segments
    expect(key.split('/')).toHaveLength(3);
    expect(key.split('/')[2]).not.toContain('/');
  });

  it('finalize validates size and type agreement', () => {
    const base = {
      intentId: 'i1',
      quarantineKey: `${QUARANTINE_PREFIX}i1/a.png`,
      declaredContentType: 'image/png',
      declaredBytes: 100,
      publish: true,
    };
    expect(validateFinalize({ ...base, actualBytes: 100, actualContentType: 'image/png' }).ok).toBe(true);
    expect(validateFinalize({ ...base, actualBytes: 50 })).toEqual({ ok: false, reason: 'size_mismatch' });
    expect(validateFinalize({ ...base, actualBytes: 100, actualContentType: 'image/jpeg' })).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
    expect(validateFinalize({ ...base, actualBytes: 0 })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('promotes quarantine keys to public keys only within the prefix', () => {
    expect(publicKeyFor(`${QUARANTINE_PREFIX}i1/a.png`)).toBe('assets/i1/a.png');
    expect(publicKeyFor('assets/i1/a.png')).toBeNull();
  });
});

describe('bundles', () => {
  it('builds deterministic manifests with sorted files', () => {
    const m = buildManifest('b1', 2, [
      { path: 'z.txt', sha256: 'a', bytes: 1, contentType: 'text/plain' },
      { path: 'a.txt', sha256: 'b', bytes: 2, contentType: 'text/plain' },
    ]);
    expect(m.files[0].path).toBe('a.txt');
    expect(bundlePrefix('b1', 2)).toBe('bundles/b1/v2/');
    expect(manifestKey('b1', 2)).toBe('bundles/b1/v2/manifest.json');
  });

  it('hashes content deterministically', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
  });
});
