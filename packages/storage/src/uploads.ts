/**
 * Asset upload flow: POST /assets/upload-intent -> client PUTs bytes to the
 * quarantine prefix in the PRIVATE bucket -> POST /assets/:id/finalize
 * validates size/type, scans, then promotes to the public bucket (or keeps
 * private). All validation rules live here as importable functions so the
 * worker lane (async virus/safety scan) shares them.
 */

export const QUARANTINE_PREFIX = 'quarantine/';
export const PUBLIC_ASSETS_PREFIX = 'assets/';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB default cap

/** Allowlisted content types — never accept arbitrary types into the public bucket. */
export const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
]);

export interface UploadIntent {
  id: string;
  quarantineKey: string;
  maxBytes: number;
  allowedContentType: string;
  expiresAtMs: number;
}

export interface FinalizeInput {
  intentId: string;
  quarantineKey: string;
  declaredContentType: string;
  declaredBytes: number;
  /** actual bytes observed at finalize time (from HEAD on the quarantine object) */
  actualBytes: number;
  actualContentType?: string;
  publish: boolean;
}

export type FinalizeResult =
  | { ok: true; publicKey?: string }
  | { ok: false; reason: 'too_large' | 'type_not_allowed' | 'size_mismatch' | 'type_mismatch' | 'not_found' };

export function buildQuarantineKey(intentId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'file';
  return `${QUARANTINE_PREFIX}${intentId}/${safe}`;
}

export function validateIntentRequest(input: {
  filename: string;
  contentType: string;
  bytes: number;
  maxBytes?: number;
}): { ok: true } | { ok: false; reason: 'type_not_allowed' | 'too_large' | 'bad_filename' } {
  if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) return { ok: false, reason: 'type_not_allowed' };
  const maxBytes = input.maxBytes ?? MAX_UPLOAD_BYTES;
  if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }
  if (!input.filename || input.filename.length > 256) return { ok: false, reason: 'bad_filename' };
  return { ok: true };
}

/**
 * Finalize validation — pure function. The worker's async scan result feeds
 * `scanClean`; a failed scan keeps the object quarantined.
 */
export function validateFinalize(input: FinalizeInput, maxBytes = MAX_UPLOAD_BYTES): FinalizeResult {
  if (input.actualBytes === 0) return { ok: false, reason: 'not_found' };
  if (input.actualBytes > maxBytes || input.declaredBytes > maxBytes) return { ok: false, reason: 'too_large' };
  if (input.actualBytes !== input.declaredBytes) return { ok: false, reason: 'size_mismatch' };
  if (!ALLOWED_CONTENT_TYPES.has(input.declaredContentType)) return { ok: false, reason: 'type_not_allowed' };
  if (input.actualContentType && input.actualContentType !== input.declaredContentType) {
    return { ok: false, reason: 'type_mismatch' };
  }
  return { ok: true };
}

export function publicKeyFor(quarantineKey: string): string | null {
  if (!quarantineKey.startsWith(QUARANTINE_PREFIX)) return null;
  return PUBLIC_ASSETS_PREFIX + quarantineKey.slice(QUARANTINE_PREFIX.length);
}
