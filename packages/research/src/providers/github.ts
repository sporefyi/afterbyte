/**
 * GitHub adapter — public repository and release data via the GitHub REST API.
 * No authentication: public data only, 60 req/hour unauthenticated budget.
 * Rate-limit aware: tracks X-RateLimit headers and reports quota_exhausted
 * honestly instead of pretending.
 */
import { randomUUID } from 'node:crypto';
import { safeFetch, SafeFetchError, SsrfBlockedError, type DnsResolver } from './ssrf.js';
import type {
  CandidateSource,
  DiscoverContext,
  FetchOptions,
  FetchOutcome,
  NormalizedSource,
  ProviderCapabilities,
  ProviderHealth,
  ResearchProvider,
  SourceSnapshot,
} from './types.js';

export const GITHUB_PROVIDER_ID = 'github';

const CAPABILITIES: ProviderCapabilities = {
  requiresCredential: false,
  credentialName: 'GITHUB_TOKEN (optional; raises unauthenticated 60 req/hour budget)',
  perDomainConcurrency: 2,
  rateLimit: { requests: 60, perSeconds: 3600 },
  fetchTimeoutMs: 15_000,
  maxBodyBytes: 1_000_000,
  retention: 'raw snapshots 24 months, then digest-only',
  attribution: 'data via api.github.com; © respective repository owners',
  conditionalRequests: false, // ETag supported by API but we keep it simple
};

const API = 'https://api.github.com';
const UA = 'AFTERBYTE-research/0.1 (+research fetcher)';

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** Extract owner/repo from github.com URLs. Returns null for non-repo URLs. */
export function parseRepoUrl(url: string): GitHubRepoRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== 'github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  let repo = parts[1].replace(/\.git$/i, '');
  if (!/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo)) return null;
  return { owner, repo };
}

interface RateState {
  remaining: number | null;
  resetAt: string | null;
  observedAt: string;
}

export interface GitHubAdapterOptions {
  userAgent?: string;
  dns?: DnsResolver;
}

export class GitHubAdapter implements ResearchProvider {
  readonly providerId = GITHUB_PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = CAPABILITIES;
  private consecutiveFailures = 0;
  private rate: RateState = { remaining: null, resetAt: null, observedAt: new Date(0).toISOString() };
  private readonly ua: string;
  private readonly dns?: DnsResolver;

  constructor(opts: GitHubAdapterOptions = {}) {
    this.ua = opts.userAgent ?? UA;
    this.dns = opts.dns;
  }

  /** Exposed for tests/pipeline: current rate-limit view. */
  get rateState(): RateState {
    return { ...this.rate };
  }

  /** Test hook: simulate an exhausted quota without hitting the network. */
  setRateStateForTests(remaining: number, resetAt: string): void {
    this.rate = { remaining, resetAt, observedAt: new Date().toISOString() };
  }

  private recordRateLimit(headers: Record<string, string>) {
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];
    this.rate = {
      remaining: remaining !== undefined ? Number(remaining) : this.rate.remaining,
      resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : this.rate.resetAt,
      observedAt: new Date().toISOString(),
    };
  }

  private quotaExhausted(): boolean {
    return (
      this.rate.remaining === 0 &&
      this.rate.resetAt !== null &&
      Date.parse(this.rate.resetAt) > Date.now()
    );
  }

  private async apiJson(path: string, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; json: unknown }> {
    const res = await safeFetch(`${API}${path}`, {
      maxBodyBytes: CAPABILITIES.maxBodyBytes,
      timeoutMs: CAPABILITIES.fetchTimeoutMs,
      userAgent: this.ua,
      signal,
      dns: this.dns,
    });
    this.recordRateLimit(res.headers);
    let json: unknown = null;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch {
      // keep null; caller checks status
    }
    return { status: res.statusCode, headers: res.headers, json };
  }

  async discover(ctx: DiscoverContext): Promise<CandidateSource[]> {
    const seen = new Set<string>();
    const out: CandidateSource[] = [];
    for (const raw of ctx.knownUrls) {
      const ref = parseRepoUrl(raw);
      if (!ref) continue;
      const key = `${ref.owner}/${ref.repo}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        candidateId: `${GITHUB_PROVIDER_ID}:${out.length}`,
        url: `https://github.com/${ref.owner}/${ref.repo}`,
        rationale: `public GitHub repository ${ref.owner}/${ref.repo}`,
        estimatedRelevance: 0.85,
      });
      if (out.length >= ctx.maxCandidates) break;
    }
    return out;
  }

  async fetch(candidate: CandidateSource, opts: FetchOptions = {}): Promise<FetchOutcome> {
    if (this.quotaExhausted()) {
      return {
        error: {
          code: 'QUOTA_EXHAUSTED',
          message: `GitHub API rate limit exhausted until ${this.rate.resetAt}`,
          retryable: true,
        },
      };
    }
    const ref = parseRepoUrl(candidate.url);
    if (!ref) {
      return { error: { code: 'NOT_A_REPO_URL', message: `not a github.com repo URL: ${candidate.url}`, retryable: false } };
    }
    try {
      const [repoRes, relRes] = await Promise.all([
        this.apiJson(`/repos/${ref.owner}/${ref.repo}`, opts.signal),
        this.apiJson(`/repos/${ref.owner}/${ref.repo}/releases?per_page=5`, opts.signal),
      ]);
      if (repoRes.status === 404) {
        this.consecutiveFailures += 1;
        return { error: { code: 'REPO_NOT_FOUND', message: `${ref.owner}/${ref.repo} not found`, retryable: false } };
      }
      if (repoRes.status === 403 || repoRes.status === 429) {
        this.consecutiveFailures += 1;
        return {
          error: {
            code: 'QUOTA_EXHAUSTED',
            message: `GitHub API rate limit hit; resets at ${this.rate.resetAt ?? 'unknown'}`,
            retryable: true,
          },
        };
      }
      if (repoRes.status !== 200) {
        this.consecutiveFailures += 1;
        return {
          error: { code: `HTTP_${repoRes.status}`, message: `GitHub API returned ${repoRes.status}`, retryable: repoRes.status >= 500 },
        };
      }
      this.consecutiveFailures = 0;
      const payload = JSON.stringify(
        { repository: repoRes.json, releases: relRes.status === 200 ? relRes.json : null },
        null,
        2,
      );
      const body = Buffer.from(payload, 'utf8');
      const { createHash } = await import('node:crypto');
      const now = new Date().toISOString();
      const snapshot: SourceSnapshot = {
        snapshotId: `snap_${randomUUID()}`,
        providerId: this.providerId,
        originalUrl: candidate.url,
        finalUrl: candidate.url,
        redirectHistory: [],
        fetchedAt: now,
        statusCode: 200,
        contentType: 'application/json',
        bytes: body.length,
        truncated: false,
        contentHash: createHash('sha256').update(body).digest('hex'),
        body,
        attribution: CAPABILITIES.attribution,
      };
      return { snapshot };
    } catch (err) {
      this.consecutiveFailures += 1;
      if (err instanceof SsrfBlockedError) {
        return { error: { code: err.code, message: err.message, retryable: false } };
      }
      if (err instanceof SafeFetchError) {
        return { error: { code: err.code, message: err.message, retryable: err.retryable } };
      }
      return { error: { code: 'UNKNOWN', message: (err as Error).message, retryable: true } };
    }
  }

  async normalize(snapshot: SourceSnapshot): Promise<NormalizedSource> {
    let repo: Record<string, unknown> = {};
    let releases: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(snapshot.body.toString('utf8')) as {
        repository: Record<string, unknown>;
        releases: Array<Record<string, unknown>> | null;
      };
      repo = parsed.repository ?? {};
      releases = parsed.releases ?? [];
    } catch {
      // keep empty; excerpt will note the parse failure
    }
    const fullName = typeof repo['full_name'] === 'string' ? repo['full_name'] : snapshot.originalUrl;
    const lines = [
      `Repository: ${fullName}`,
      `Description: ${repo['description'] ?? '—'}`,
      `Archived: ${repo['archived'] ?? 'unknown'}`,
      `Last push: ${repo['pushed_at'] ?? 'unknown'}`,
      `Default branch: ${repo['default_branch'] ?? 'unknown'}`,
      `Stars: ${repo['stargazers_count'] ?? 'unknown'} | Forks: ${repo['forks_count'] ?? 'unknown'} | Open issues: ${repo['open_issues_count'] ?? 'unknown'}`,
      `Homepage: ${repo['homepage'] ?? '—'}`,
    ];
    for (const r of releases.slice(0, 5)) {
      lines.push(`Release ${r['tag_name'] ?? '?'} published ${r['published_at'] ?? 'unknown'}${r['prerelease'] ? ' (prerelease)' : ''}`);
    }
    if (releases.length === 0) lines.push('No releases published (or releases endpoint unavailable).');
    return {
      snapshotId: snapshot.snapshotId,
      providerId: snapshot.providerId,
      url: snapshot.finalUrl,
      title: typeof fullName === 'string' ? fullName : undefined,
      excerpt: lines.join('\n').slice(0, 2000),
      text: lines.join('\n'),
      contentHash: snapshot.contentHash,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async health(): Promise<ProviderHealth> {
    if (this.quotaExhausted()) {
      return {
        providerId: this.providerId,
        availability: 'quota_exhausted',
        reason: `unauthenticated GitHub API budget exhausted; resets ${this.rate.resetAt}`,
        checkedAt: new Date().toISOString(),
        retryAfter: this.rate.resetAt ?? undefined,
        consecutiveFailures: this.consecutiveFailures,
      };
    }
    return {
      providerId: this.providerId,
      availability: 'available',
      reason:
        this.rate.remaining === null
          ? 'no requests made yet this session; 60 req/hour unauthenticated budget'
          : `${this.rate.remaining} requests remaining in current window`,
      checkedAt: new Date().toISOString(),
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
