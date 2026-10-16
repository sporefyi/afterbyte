/**
 * Config validation on startup per .env.example and ADR-0003.
 *
 * Core missing credentials fail the affected service with a clear error.
 * Optional missing providers disable their capabilities; /config reports
 * the real provider status so the frontend can hide unavailable controls.
 */

export type AppEnv = 'dev' | 'staging' | 'production';

export interface StorageConfig {
  endpoint: string;
  bucketPublic: string;
  bucketPrivate: string;
  accessKey: string;
  secretKey: string;
  publicMediaBaseUrl: string;
  region: string;
}

export interface SolanaConfig {
  cluster: string;
  rpcUrl: string;
  rpcFallbackUrl?: string;
  programId?: string;
}

export interface PaymentsConfig {
  enabled: boolean;
  treasuryPublicKey?: string;
  usdcMint?: string;
}

export interface ApiConfig {
  appEnv: AppEnv;
  port: number;
  host: string;
  publicSiteUrl: string;
  apiOrigin: string;
  allowedOrigins: string[];
  databaseUrl: string;
  redisUrl?: string;
  sessionSecret: string;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  sessionCookieSecure: boolean;
  objectStorage: StorageConfig | null;
  searchProviderKey?: string;
  modelProviderKey?: string;
  solana: SolanaConfig;
  payments: PaymentsConfig;
  tokenEnabled: boolean;
  tokenMint?: string;
  publicCacheTtlSeconds: number;
  researchDailyBudget?: string;
  researchMaxRunCost?: string;
  useFixtureSeed: boolean;
}

export interface Capabilities {
  storage: boolean;
  search: boolean;
  models: boolean;
  receipts: boolean;
  payments: boolean;
  token: boolean;
}

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Missing required configuration: ${missing.join(', ')}. See .env.example.`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

function opt(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function req(env: NodeJS.ProcessEnv, key: string, missing: string[]): string | undefined {
  const v = opt(env, key);
  if (v === undefined) missing.push(key);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): { config: ApiConfig; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];

  const appEnvRaw = opt(env, 'APP_ENV') ?? 'dev';
  if (!['dev', 'staging', 'production'].includes(appEnvRaw)) {
    throw new ConfigError([`APP_ENV must be dev|staging|production (got "${appEnvRaw}")`]);
  }
  const appEnv = appEnvRaw as AppEnv;

  const sessionSecret = req(env, 'SESSION_SECRET', missing);
  const databaseUrl = req(env, 'DATABASE_URL', missing);
  const redisUrl = opt(env, 'REDIS_URL');
  if (!redisUrl) {
    if (appEnv === 'production') {
      missing.push('REDIS_URL (required in production for sessions, rate limits, SSE dedupe)');
    } else {
      warnings.push('REDIS_URL not set — using in-memory session/challenge stores (dev only, not for production)');
    }
  }
  if (sessionSecret !== undefined && sessionSecret.length < 32) {
    throw new ConfigError(['SESSION_SECRET must be at least 32 characters']);
  }

  const allowedOrigins = (opt(env, 'ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const storageEndpoint = opt(env, 'OBJECT_STORAGE_ENDPOINT');
  const storageAccessKey = opt(env, 'OBJECT_STORAGE_ACCESS_KEY');
  const storageSecretKey = opt(env, 'OBJECT_STORAGE_SECRET_KEY');
  const storagePublicBucket = opt(env, 'OBJECT_STORAGE_BUCKET_PUBLIC');
  const storagePrivateBucket = opt(env, 'OBJECT_STORAGE_BUCKET_PRIVATE');
  const publicMediaBaseUrl = opt(env, 'PUBLIC_MEDIA_BASE_URL');
  let objectStorage: StorageConfig | null = null;
  const storageParts = {
    OBJECT_STORAGE_ENDPOINT: storageEndpoint,
    OBJECT_STORAGE_ACCESS_KEY: storageAccessKey,
    OBJECT_STORAGE_SECRET_KEY: storageSecretKey,
    OBJECT_STORAGE_BUCKET_PUBLIC: storagePublicBucket,
    OBJECT_STORAGE_BUCKET_PRIVATE: storagePrivateBucket,
    PUBLIC_MEDIA_BASE_URL: publicMediaBaseUrl,
  };
  const storageSet = Object.entries(storageParts).filter(([, v]) => v !== undefined);
  if (storageSet.length === Object.keys(storageParts).length) {
    objectStorage = {
      endpoint: storageEndpoint!,
      bucketPublic: storagePublicBucket!,
      bucketPrivate: storagePrivateBucket!,
      accessKey: storageAccessKey!,
      secretKey: storageSecretKey!,
      publicMediaBaseUrl: publicMediaBaseUrl!,
      region: opt(env, 'OBJECT_STORAGE_REGION') ?? 'us-east-1',
    };
  } else if (storageSet.length > 0) {
    warnings.push(
      `Partial object-storage config (${storageSet.map(([k]) => k).join(', ')}); asset uploads disabled until complete`,
    );
  } else {
    warnings.push('Object storage not configured — /admin/assets endpoints will report PROVIDER_UNAVAILABLE');
  }

  const paymentsEnabledFlag = (opt(env, 'PAYMENTS_ENABLED') ?? 'false').toLowerCase() === 'true';
  const treasuryPublicKey = opt(env, 'TREASURY_PUBLIC_KEY');
  const usdcMint = opt(env, 'USDC_MINT');
  const paymentsEnabled = paymentsEnabledFlag && !!treasuryPublicKey && !!usdcMint;
  if (paymentsEnabledFlag && !paymentsEnabled) {
    warnings.push('PAYMENTS_ENABLED=true but TREASURY_PUBLIC_KEY/USDC_MINT missing — payments stay disabled');
  }

  const tokenEnabled = (opt(env, 'TOKEN_ENABLED') ?? 'false').toLowerCase() === 'true';
  if (tokenEnabled) {
    warnings.push('TOKEN_ENABLED=true is not supported in Release A — token capability stays off');
  }

  const searchProviderKey = opt(env, 'SEARCH_PROVIDER_KEY');
  const modelProviderKey = opt(env, 'MODEL_PROVIDER_KEY');
  if (!searchProviderKey) warnings.push('SEARCH_PROVIDER_KEY not set — search adapter reports unavailable');
  if (!modelProviderKey) warnings.push('MODEL_PROVIDER_KEY not set — AI research runs stay queued/awaiting_provider; public reads unaffected');

  const solanaRpcUrl = opt(env, 'SOLANA_RPC_URL');
  const programId = opt(env, 'RECEIPT_PROGRAM_ID');
  if (!solanaRpcUrl || !programId) {
    warnings.push('Solana receipt config incomplete — receipt state pending/unavailable; publication unaffected');
  }

  if (missing.length > 0) throw new ConfigError(missing);

  const config: ApiConfig = {
    appEnv,
    port: Number.parseInt(opt(env, 'PORT') ?? '3000', 10),
    host: opt(env, 'HOST') ?? '0.0.0.0',
    publicSiteUrl: opt(env, 'PUBLIC_SITE_URL') ?? '',
    apiOrigin: opt(env, 'API_ORIGIN') ?? '',
    allowedOrigins,
    databaseUrl: databaseUrl!,
    redisUrl,
    sessionSecret: sessionSecret!,
    sessionIdleMinutes: Number.parseInt(opt(env, 'SESSION_IDLE_MINUTES') ?? '30', 10),
    sessionAbsoluteHours: Number.parseInt(opt(env, 'SESSION_ABSOLUTE_HOURS') ?? '24', 10),
    sessionCookieSecure: appEnv === 'production',
    objectStorage,
    searchProviderKey,
    modelProviderKey,
    solana: {
      cluster: opt(env, 'SOLANA_CLUSTER') ?? 'devnet',
      rpcUrl: solanaRpcUrl ?? '',
      rpcFallbackUrl: opt(env, 'SOLANA_RPC_FALLBACK_URL'),
      programId,
    },
    payments: { enabled: paymentsEnabled, treasuryPublicKey, usdcMint },
    tokenEnabled: false, // Release A: always off regardless of flag
    tokenMint: opt(env, 'TOKEN_MINT'),
    publicCacheTtlSeconds: Number.parseInt(opt(env, 'PUBLIC_CACHE_TTL_SECONDS') ?? '45', 10),
    researchDailyBudget: opt(env, 'RESEARCH_DAILY_BUDGET'),
    researchMaxRunCost: opt(env, 'RESEARCH_MAX_RUN_COST'),
    useFixtureSeed: ['true', '1', 'yes'].includes((opt(env, 'AFTERBYTE_SEED_FIXTURES') ?? 'false').toLowerCase()),
  };

  return { config, warnings };
}

export function capabilitiesOf(config: ApiConfig): Capabilities {
  return {
    storage: config.objectStorage !== null,
    search: !!config.searchProviderKey,
    models: !!config.modelProviderKey,
    receipts: !!config.solana.rpcUrl && !!config.solana.programId,
    payments: config.payments.enabled,
    token: false, // Release A
  };
}
