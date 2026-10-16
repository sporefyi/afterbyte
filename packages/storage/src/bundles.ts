/**
 * Versioned bundles: content-addressed immutable objects. A bundle is a set
 * of files published under a versioned prefix; the manifest carries the
 * SHA-256 of every file so readers can verify integrity without trusting
 * the transport.
 */
import { createHash } from 'node:crypto';

export interface BundleFile {
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface BundleManifest {
  bundleId: string;
  version: number;
  createdAt: string;
  files: BundleFile[];
}

export function bundlePrefix(bundleId: string, version: number): string {
  return `bundles/${bundleId}/v${version}/`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function buildManifest(bundleId: string, version: number, files: BundleFile[]): BundleManifest {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    bundleId,
    version,
    createdAt: new Date().toISOString(),
    files: sorted,
  };
}

export function manifestKey(bundleId: string, version: number): string {
  return `${bundlePrefix(bundleId, version)}manifest.json`;
}
