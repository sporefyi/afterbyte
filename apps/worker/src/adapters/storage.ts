/**
 * Real @afterbyte/storage adapter for the worker.
 *
 * Implements the StoragePackage interface (moved here from src/shims/storage.ts
 * when the shims were deleted) backed by the real @afterbyte/storage
 * StorageClient (S3-compatible).
 *
 * Bucket routing: the shim interface's putObject/getObject/headObject/
 * deleteObjects/listStalePreparedObjects operate on the PUBLIC bucket —
 * they exist for canonical publication bundles and share cards (brief §9:
 * versioned public publication bundles). Private helpers (putPrivate, …)
 * are exposed on the class for source snapshots and other
 * access-controlled artifacts; the research adapter uses those.
 *
 * All writes are idempotent at the key level (same key+bytes = no-op
 * success) because content-addressed keys are deterministic.
 */

import { StorageClient, type StorageConfig } from '@afterbyte/storage';

export interface StoragePackage {
  /**
   * Write bytes at a content-addressed key (PUBLIC bucket). Must be
   * idempotent: writing the same key+bytes twice is a no-op success.
   */
  putObject(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ key: string; size: number }>;
  /** Re-read bytes to verify digest after write (brief §9). */
  getObject(key: string): Promise<Uint8Array>;
  /** Byte size, or null when the key does not exist. */
  headObject(key: string): Promise<{ size: number } | null>;
  /** Delete prepared-but-never-committed objects older than the retention window. */
  deleteObjects(keys: string[]): Promise<void>;
  /** Keys under a prefix older than `olderThan` (for orphan cleanup). */
  listStalePreparedObjects(prefix: string, olderThan: string): Promise<string[]>;
}

export interface StorageAdapterOptions {
  config: StorageConfig;
}

/**
 * Build a StorageClient from environment. Returns null when storage is not
 * configured — the worker then fails loudly on storage-backed steps instead
 * of fabricating results (ADR-0003).
 */
export function storageConfigFromEnv(): StorageConfig | null {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? process.env.STORAGE_ENDPOINT ?? null;
  const bucketPublic =
    process.env.OBJECT_STORAGE_BUCKET_PUBLIC ?? process.env.STORAGE_PUBLIC_BUCKET ?? null;
  const bucketPrivate = process.env.OBJECT_STORAGE_BUCKET_PRIVATE ?? null;
  const accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY ?? null;
  const secretKey = process.env.OBJECT_STORAGE_SECRET_KEY ?? null;
  const publicMediaBaseUrl = process.env.PUBLIC_MEDIA_BASE_URL ?? '';
  if (!endpoint || !bucketPublic || !bucketPrivate || !accessKey || !secretKey) return null;
  return {
    endpoint,
    region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
    accessKey,
    secretKey,
    bucketPublic,
    bucketPrivate,
    publicMediaBaseUrl,
    forcePathStyle: true,
  };
}

export class StorageAdapter implements StoragePackage {
  readonly client: StorageClient;

  constructor(config: StorageConfig) {
    this.client = new StorageClient(config);
  }

  async putObject(key: string, bytes: Uint8Array, contentType: string) {
    await this.client.put('public', key, bytes, contentType);
    return { key, size: bytes.length };
  }

  async getObject(key: string): Promise<Uint8Array> {
    return this.client.get('public', key);
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    const head = await this.client.head('public', key);
    return head ? { size: head.size } : null;
  }

  async deleteObjects(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.client.delete('public', key)));
  }

  async listStalePreparedObjects(prefix: string, olderThan: string): Promise<string[]> {
    // S3 list has no mtime filter; the maintenance job filters by key
    // recency heuristics. List is bounded; callers filter further.
    void olderThan;
    return this.client.list('public', prefix, 1000);
  }

  // ---- private-bucket helpers (source snapshots, quarantined artifacts) ----

  async putPrivateObject(key: string, bytes: Uint8Array, contentType: string) {
    await this.client.put('private', key, bytes, contentType);
    return { key, size: bytes.length };
  }

  async getPrivateObject(key: string): Promise<Uint8Array> {
    return this.client.get('private', key);
  }

  async deletePrivateObjects(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.client.delete('private', key)));
  }

  /** Public serving URL for a public-bucket key (no signed URLs). */
  publicUrl(key: string): string {
    return this.client.publicUrl(key);
  }
}

export function createStorageAdapter(): StorageAdapter | null {
  const config = storageConfigFromEnv();
  return config ? new StorageAdapter(config) : null;
}
