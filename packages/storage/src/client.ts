/**
 * S3-compatible storage client wrapper (MinIO locally, any S3-compatible
 * endpoint in staging/production). Two buckets: public (served directly via
 * PUBLIC_MEDIA_BASE_URL — no signed URLs) and private (quarantine +
 * internal artifacts).
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucketPublic: string;
  bucketPrivate: string;
  /** Base URL under which the PUBLIC bucket is served, e.g. https://media.afterbyte.example */
  publicMediaBaseUrl: string;
  forcePathStyle?: boolean;
}

export type BucketKind = 'public' | 'private';

export class StorageClient {
  private s3: S3Client;
  private readonly buckets: Record<BucketKind, string>;
  readonly publicMediaBaseUrl: string;

  constructor(config: StorageConfig) {
    const s3Config: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      forcePathStyle: config.forcePathStyle ?? true,
    };
    this.s3 = new S3Client(s3Config);
    this.buckets = { public: config.bucketPublic, private: config.bucketPrivate };
    this.publicMediaBaseUrl = config.publicMediaBaseUrl.replace(/\/+$/, '');
  }

  private bucket(kind: BucketKind): string {
    return this.buckets[kind];
  }

  async put(kind: BucketKind, key: string, body: Uint8Array | Buffer | string, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket(kind), Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(kind: BucketKind, key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket(kind), Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return bytes;
  }

  async head(kind: BucketKind, key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket(kind), Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch {
      return null;
    }
  }

  async delete(kind: BucketKind, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket(kind), Key: key }));
  }

  async list(kind: BucketKind, prefix: string, maxKeys = 100): Promise<string[]> {
    const res = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket(kind), Prefix: prefix, MaxKeys: maxKeys }),
    );
    return (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
  }

  /** Signed-URL-free public serving: the public bucket is fronted by PUBLIC_MEDIA_BASE_URL. */
  publicUrl(key: string): string {
    const clean = key.replace(/^\/+/, '');
    return `${this.publicMediaBaseUrl}/${clean}`;
  }
}
