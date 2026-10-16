/**
 * Worker configuration. Validated at startup; missing core credentials fail
 * the affected service with a clear error, optional providers disable their
 * capabilities (ADR-0003).
 */

export interface WorkerConfig {
  appEnv: 'dev' | 'staging' | 'production';
  databaseUrl: string;
  redisUrl: string;
  /** Primary Solana RPC for receipt anchoring/reconciliation. */
  solanaRpcUrl: string | null;
  /** Fallback RPC used when the primary is unreachable or disagrees. */
  solanaRpcFallbackUrl: string | null;
  receiptProgramId: string | null;
  /** Storage endpoints (S3-compatible). Null → storage-backed steps unavailable. */
  storagePublicBucket: string | null;
  storageEndpoint: string | null;
  paymentsEnabled: boolean;
  tokenEnabled: boolean;
  /** Seconds between outbox dispatcher ticks. */
  outboxPollIntervalSec: number;
  /** Seconds between worker heartbeat writes. */
  heartbeatIntervalSec: number;
  /** Age after which a dispatched-but-unacked outbox event is redelivered. */
  outboxStuckAfterSec: number;
  /** Age after which a running job with no heartbeat is declared stranded. */
  jobStrandedAfterSec: number;
  workerId: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[worker config] missing required env var ${name}`);
  return v;
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.length > 0 ? v : null;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[worker config] ${name} must be a positive number, got ${v}`);
  }
  return n;
}

export function loadConfig(): WorkerConfig {
  const appEnv = process.env.APP_ENV ?? 'dev';
  if (!['dev', 'staging', 'production'].includes(appEnv)) {
    throw new Error(`[worker config] APP_ENV must be dev|staging|production, got ${appEnv}`);
  }
  const paymentsEnabled = bool('PAYMENTS_ENABLED', false);
  if (paymentsEnabled) {
    // ADR-0003: payments stay disabled until the settlement path is verified.
    // The worker refuses to run payment reconciliation without treasury config.
    required('TREASURY_ADDRESS');
    required('USDC_MINT_ADDRESS');
  }
  return {
    appEnv: appEnv as WorkerConfig['appEnv'],
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    solanaRpcUrl: optional('SOLANA_RPC_URL'),
    solanaRpcFallbackUrl: optional('SOLANA_RPC_FALLBACK_URL'),
    receiptProgramId: optional('RECEIPT_PROGRAM_ID'),
    storagePublicBucket: optional('STORAGE_PUBLIC_BUCKET'),
    storageEndpoint: optional('STORAGE_ENDPOINT'),
    paymentsEnabled,
    tokenEnabled: bool('TOKEN_ENABLED', false),
    outboxPollIntervalSec: num('OUTBOX_POLL_INTERVAL_SEC', 5),
    heartbeatIntervalSec: num('WORKER_HEARTBEAT_INTERVAL_SEC', 20),
    outboxStuckAfterSec: num('OUTBOX_STUCK_AFTER_SEC', 120),
    jobStrandedAfterSec: num('JOB_STRANDED_AFTER_SEC', 600),
    workerId:
      optional('WORKER_ID') ??
      `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  };
}
