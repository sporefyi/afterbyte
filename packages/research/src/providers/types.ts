/**
 * Provider interface for AFTERBYTE source collection (brief §6).
 *
 * Every adapter implements discover()/fetch()/normalize()/health() with typed
 * outputs, and declares its capability flags: credentials, per-domain
 * concurrency, rate limits, timeouts, max body size, retention and attribution.
 *
 * Disabled or quota-exhausted adapters must report their actual state via
 * health() — they must never pretend to work.
 */

/** Stable subject classification used across pipeline + lifecycle policy. */
export type SubjectKind =
  | 'app'
  | 'website'
  | 'game'
  | 'meme'
  | 'community'
  | 'crypto_project'
  | 'other';

export interface ProviderCapabilities {
  /** True when this adapter needs a credential that is currently absent. */
  requiresCredential: boolean;
  /** Name of the env var / credential reference when one is required. */
  credentialName?: string;
  /** Max concurrent in-flight fetches per registrable domain. */
  perDomainConcurrency: number;
  /** Requests per window the adapter will self-impose. */
  rateLimit: { requests: number; perSeconds: number };
  /** Hard timeout per fetch attempt, ms. */
  fetchTimeoutMs: number;
  /** Largest response body the adapter will buffer, bytes. */
  maxBodyBytes: number;
  /** How long raw snapshots are retained (ISO-8601 duration-ish label). */
  retention: string;
  /** Human attribution string recorded on every snapshot. */
  attribution: string;
  /** Whether the adapter honours conditional requests (ETag/Last-Modified). */
  conditionalRequests: boolean;
}

export interface CandidateSource {
  /** Stable id for this candidate within a run (e.g. `website:3`). */
  candidateId: string;
  /** Original URL as discovered (pre-redirect). */
  url: string;
  /** Why this candidate was chosen. */
  rationale: string;
  /** Estimated relevance 0..1 for budget triage. */
  estimatedRelevance: number;
}

export interface RedirectHop {
  url: string;
  status: number;
  at: string; // ISO-8601
}

/** Raw fetched bytes + provenance. Body is access-controlled; never public. */
export interface SourceSnapshot {
  snapshotId: string;
  providerId: string;
  /** URL as requested. */
  originalUrl: string;
  /** URL after redirects. */
  finalUrl: string;
  redirectHistory: RedirectHop[];
  fetchedAt: string; // ISO-8601
  statusCode: number;
  contentType?: string;
  /** Bytes actually buffered (<= maxBodyBytes). */
  bytes: number;
  /** True when the body was truncated at maxBodyBytes. */
  truncated: boolean;
  /** SHA-256 of the buffered bytes, hex. */
  contentHash: string;
  /** Conditional-request state for next time. */
  etag?: string;
  lastModified?: string;
  /** Raw body. Hostile input — quote, never execute or interpolate. */
  body: Buffer;
  attribution: string;
}

/** Adapter-normalized, evidence-ready view of a snapshot. */
export interface NormalizedSource {
  snapshotId: string;
  providerId: string;
  url: string;
  title?: string;
  /** Author/byline when the source states one. */
  author?: string;
  /** Publication time when the source states one; never invented. */
  publishedAt?: string;
  /** Plain-text excerpt for evidence spans (bounded length). */
  excerpt: string;
  /** Full plain text when safely extractable (HTML stripped). */
  text?: string;
  language?: string;
  contentHash: string;
  fetchedAt: string;
}

export type ProviderAvailability =
  | 'available'
  | 'disabled' // capability explicitly off (e.g. missing credential)
  | 'quota_exhausted'
  | 'degraded';

export interface ProviderHealth {
  providerId: string;
  availability: ProviderAvailability;
  /** Human reason, e.g. "MODEL_PROVIDER_KEY absent" or "429 quota exhausted". */
  reason: string;
  checkedAt: string;
  /** When degraded/quota_exhausted, earliest time a retry makes sense. */
  retryAfter?: string;
  consecutiveFailures: number;
}

export interface DiscoverContext {
  subjectName: string;
  subjectKind: SubjectKind;
  aliases: string[];
  knownUrls: string[];
  /** Hard cap from the run budget (brief §7: default 15). */
  maxCandidates: number;
}

export interface FetchOptions {
  /** Conditional request state from a previous snapshot, if any. */
  etag?: string;
  lastModified?: string;
  /** AbortSignal from the run's time/cancellation budget. */
  signal?: AbortSignal;
}

export interface FetchOutcome {
  snapshot?: SourceSnapshot;
  /** HTTP 304 — nothing new; reuse previous snapshot. */
  notModified?: boolean;
  /** Non-retryable fetch failure recorded as a coverage gap. */
  error?: { code: string; message: string; retryable: boolean };
}

export interface ResearchProvider {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  discover(ctx: DiscoverContext): Promise<CandidateSource[]>;
  fetch(candidate: CandidateSource, opts?: FetchOptions): Promise<FetchOutcome>;
  normalize(snapshot: SourceSnapshot): Promise<NormalizedSource>;
  health(): Promise<ProviderHealth>;
}

/** Optional fetch throttling contract adapters expose for the pipeline. */
export interface DomainThrottle {
  perDomainConcurrency: number;
  minIntervalMs: number;
}
