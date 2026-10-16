/**
 * Website adapter — official sites and general web pages via the SSRF-safe
 * HTTP client (brief §6). No rendering of active content: we parse static HTML
 * only, and treat all page text as hostile quoted data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { safeFetch, SafeFetchError, SsrfBlockedError, type DnsResolver, type SafeFetchOptions } from './ssrf.js';
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

export const WEBSITE_PROVIDER_ID = 'website';

const CAPABILITIES: ProviderCapabilities = {
  requiresCredential: false,
  perDomainConcurrency: 2,
  rateLimit: { requests: 30, perSeconds: 60 },
  fetchTimeoutMs: 15_000,
  maxBodyBytes: 2_000_000,
  retention: 'raw snapshots 24 months, then digest-only',
  attribution: 'fetched by AFTERBYTE research fetcher; original publisher retains all rights',
  conditionalRequests: true,
};

export interface WebsiteAdapterOptions {
  userAgent?: string;
  maxBodyBytes?: number;
  fetchTimeoutMs?: number;
  /** Extra hosts that must never be fetched (beyond SSRF ranges). */
  blocklist?: string[];
  /**
   * DNS resolver override. Production default is the system resolver; tests
   * supply a DoH resolver when the sandbox resolver is intercepted.
   */
  dns?: DnsResolver;
}

export class WebsiteAdapter implements ResearchProvider {
  readonly providerId = WEBSITE_PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = CAPABILITIES;
  private consecutiveFailures = 0;
  private readonly opts: WebsiteAdapterOptions;

  constructor(opts: WebsiteAdapterOptions = {}) {
    this.opts = opts;
  }

  async discover(ctx: DiscoverContext): Promise<CandidateSource[]> {
    // The website adapter does not invent URLs: it fetches explicitly supplied
    // known URLs (official site, docs, status page). Search-driven discovery is
    // the search provider's job (separate adapter, out of scope here).
    const seen = new Set<string>();
    const out: CandidateSource[] = [];
    for (const raw of ctx.knownUrls.slice(0, ctx.maxCandidates)) {
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        candidateId: `${WEBSITE_PROVIDER_ID}:${out.length}`,
        url: raw,
        rationale: 'explicitly supplied known URL',
        estimatedRelevance: 0.8,
      });
    }
    return out;
  }

  async fetch(candidate: CandidateSource, opts: FetchOptions = {}): Promise<FetchOutcome> {
    if (this.opts.blocklist?.some((h) => candidate.url.includes(h))) {
      return { error: { code: 'BLOCKLISTED', message: 'URL host is blocklisted', retryable: false } };
    }
    try {
      const res = await safeFetch(candidate.url, {
        maxBodyBytes: this.opts.maxBodyBytes ?? CAPABILITIES.maxBodyBytes,
        timeoutMs: this.opts.fetchTimeoutMs ?? CAPABILITIES.fetchTimeoutMs,
        userAgent: this.opts.userAgent,
        etag: opts.etag,
        lastModified: opts.lastModified,
        signal: opts.signal,
        dns: this.opts.dns,
      });
      this.consecutiveFailures = 0;
      if (res.notModified) return { notModified: true };
      const now = new Date().toISOString();
      const snapshot: SourceSnapshot = {
        snapshotId: `snap_${randomUUID()}`,
        providerId: this.providerId,
        originalUrl: candidate.url,
        finalUrl: res.finalUrl,
        redirectHistory: res.redirectHistory,
        fetchedAt: now,
        statusCode: res.statusCode,
        contentType: res.contentType,
        bytes: res.body.length,
        truncated: res.truncated,
        contentHash: res.contentHash,
        etag: res.etag,
        lastModified: res.lastModified,
        body: res.body,
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
    const text = snapshot.body.toString('utf8');
    const { title, bodyText, description } = extractText(text);
    const excerptSource = description || bodyText;
    return {
      snapshotId: snapshot.snapshotId,
      providerId: snapshot.providerId,
      url: snapshot.finalUrl,
      title,
      excerpt: excerptSource.slice(0, 2000),
      text: bodyText.slice(0, 100_000),
      contentHash: snapshot.contentHash,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.providerId,
      availability: 'available',
      reason: 'no credential required; SSRF-safe fetcher operational',
      checkedAt: new Date().toISOString(),
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

/**
 * Minimal static HTML → text extraction. Never executes scripts; strips
 * script/style/noscript/template blocks before reading text.
 */
export function extractText(html: string): { title?: string; bodyText: string; description?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,500}?)<\/title>/i);
  const descMatch = html.match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([\s\S]{0,2000}?)["']/i,
  );
  let body = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body\s*>/i);
  if (bodyMatch) body = bodyMatch[1];
  const text = body
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (m) =>
      ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m.toLowerCase()] ?? ' ',
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return {
    title: titleMatch?.[1].replace(/\s+/g, ' ').trim() || undefined,
    description: descMatch?.[1].replace(/\s+/g, ' ').trim() || undefined,
    bodyText: text,
  };
}

/** Snapshot digest for dedup without touching the body. */
export function snapshotDigest(snapshot: SourceSnapshot): string {
  return createHash('sha256').update(snapshot.contentHash).digest('hex');
}
