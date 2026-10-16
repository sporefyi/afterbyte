/**
 * RSS/Atom adapter (brief §6). Fetches explicitly configured feed URLs through
 * the SSRF-safe client and normalizes entries into candidate sources.
 */
import { randomUUID } from 'node:crypto';
import { safeFetch, SafeFetchError, SsrfBlockedError, type DnsResolver } from './ssrf.js';
import { extractText } from './website.js';
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

export const RSS_PROVIDER_ID = 'rss';

const CAPABILITIES: ProviderCapabilities = {
  requiresCredential: false,
  perDomainConcurrency: 2,
  rateLimit: { requests: 30, perSeconds: 60 },
  fetchTimeoutMs: 15_000,
  maxBodyBytes: 1_000_000,
  retention: 'raw snapshots 24 months, then digest-only',
  attribution: 'fetched by AFTERBYTE research fetcher; original publisher retains all rights',
  conditionalRequests: true,
};

export interface FeedEntry {
  title?: string;
  link?: string;
  publishedAt?: string; // ISO-8601 when parseable; never invented
  author?: string;
  summary?: string;
}

export interface ParsedFeed {
  feedTitle?: string;
  feedLink?: string;
  entries: FeedEntry[];
}

function cdataAware(tag: string, xml: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{0,20000}?)<\\/${tag}\\s*>`, 'i'));
  if (!m) return undefined;
  let v = m[1].trim();
  const cdata = v.match(/<!\[CDATA\[([\s\S]*)\]\]>/);
  if (cdata) v = cdata[1];
  return v
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || undefined;
}

function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

function atomLink(itemXml: string): string | undefined {
  // Prefer rel="alternate" (or no rel) with an href.
  const links = [...itemXml.matchAll(/<link\b([^>]{0,2000})>/gi)];
  for (const m of links) {
    const attrs = m[1];
    const href = attrs.match(/href=["']([^"']{1,2000})["']/i)?.[1];
    if (!href) continue;
    const rel = attrs.match(/rel=["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!rel || rel === 'alternate') return href;
  }
  return undefined;
}

/** Parse an RSS 2.0 or Atom 1.0 document. Tolerant but never invents data. */
export function parseFeed(xml: string): ParsedFeed {
  const entries: FeedEntry[] = [];
  const isAtom = /<feed[\s>]/.test(xml.slice(0, 2000));
  if (isAtom) {
    const feedTitle = cdataAware('title', xml);
    const feedLink = atomLink(xml);
    const items = xml.match(/<entry[\s>][\s\S]*?<\/entry\s*>/gi) ?? [];
    for (const item of items.slice(0, 200)) {
      entries.push({
        title: cdataAware('title', item),
        link: atomLink(item),
        publishedAt: parseDate(cdataAware('published', item) ?? cdataAware('updated', item)),
        author: cdataAware('author', item)?.replace(/^.*?<name[^>]*>([\s\S]*?)<\/name.*$/i, '$1') ?? cdataAware('name', item),
        summary: cdataAware('summary', item) ?? cdataAware('content', item),
      });
    }
    return { feedTitle, feedLink, entries };
  }
  // RSS 2.0
  const channel = xml.match(/<channel[\s>][\s\S]*?<\/channel\s*>/i)?.[0] ?? xml;
  const feedTitle = cdataAware('title', channel);
  const feedLink = cdataAware('link', channel);
  const items = xml.match(/<item[\s>][\s\S]*?<\/item\s*>/gi) ?? [];
  for (const item of items.slice(0, 200)) {
    const link = cdataAware('link', item);
    const guid = cdataAware('guid', item);
    entries.push({
      title: cdataAware('title', item),
      link: link ?? (guid && /^https?:\/\//i.test(guid) ? guid : undefined),
      publishedAt: parseDate(cdataAware('pubDate', item) ?? cdataAware('dc:date', item)),
      author: cdataAware('author', item) ?? cdataAware('dc:creator', item),
      summary: cdataAware('description', item) ?? cdataAware('content:encoded', item),
    });
  }
  return { feedTitle, feedLink, entries };
}

export interface RssAdapterOptions {
  dns?: DnsResolver;
}

export class RssAdapter implements ResearchProvider {
  readonly providerId = RSS_PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = CAPABILITIES;
  private consecutiveFailures = 0;
  private readonly feedUrls: string[];
  private readonly dns?: DnsResolver;

  /** feedUrls: explicitly configured feeds for the subject (brief §6). */
  constructor(feedUrls: string[] = [], opts: RssAdapterOptions = {}) {
    this.feedUrls = feedUrls;
    this.dns = opts.dns;
  }

  async discover(ctx: DiscoverContext): Promise<CandidateSource[]> {
    // Discover = read the configured feeds, surface recent entries as candidates.
    const urls = [...this.feedUrls, ...ctx.knownUrls.filter((u) => /\.(rss|xml|atom)$/i.test(u))];
    const seen = new Set<string>();
    const out: CandidateSource[] = [];
    for (const feedUrl of urls) {
      let xml: string;
      try {
        const res = await safeFetch(feedUrl, {
          maxBodyBytes: CAPABILITIES.maxBodyBytes,
          timeoutMs: CAPABILITIES.fetchTimeoutMs,
          dns: this.dns,
        });
        if (res.statusCode !== 200) continue;
        xml = res.body.toString('utf8');
      } catch {
        continue; // feed-level failures are recorded by the caller as gaps
      }
      let feed: ParsedFeed;
      try {
        feed = parseFeed(xml);
      } catch {
        continue;
      }
      for (const entry of feed.entries) {
        if (!entry.link || seen.has(entry.link.toLowerCase())) continue;
        seen.add(entry.link.toLowerCase());
        out.push({
          candidateId: `${RSS_PROVIDER_ID}:${out.length}`,
          url: entry.link,
          rationale: `feed entry${entry.title ? `: ${entry.title.slice(0, 80)}` : ''} (${feed.feedTitle ?? feedUrl})`,
          estimatedRelevance: 0.7,
        });
        if (out.length >= ctx.maxCandidates) return out;
      }
    }
    return out;
  }

  async fetch(candidate: CandidateSource, opts: FetchOptions = {}): Promise<FetchOutcome> {
    try {
      const res = await safeFetch(candidate.url, {
        maxBodyBytes: CAPABILITIES.maxBodyBytes,
        timeoutMs: CAPABILITIES.fetchTimeoutMs,
        etag: opts.etag,
        lastModified: opts.lastModified,
        signal: opts.signal,
        dns: this.dns,
      });
      this.consecutiveFailures = 0;
      if (res.notModified) return { notModified: true };
      const snapshot: SourceSnapshot = {
        snapshotId: `snap_${randomUUID()}`,
        providerId: this.providerId,
        originalUrl: candidate.url,
        finalUrl: res.finalUrl,
        redirectHistory: res.redirectHistory,
        fetchedAt: new Date().toISOString(),
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
    const { title, bodyText } = extractText(snapshot.body.toString('utf8'));
    return {
      snapshotId: snapshot.snapshotId,
      providerId: snapshot.providerId,
      url: snapshot.finalUrl,
      title,
      excerpt: bodyText.slice(0, 2000),
      text: bodyText.slice(0, 100_000),
      contentHash: snapshot.contentHash,
      fetchedAt: snapshot.fetchedAt,
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      providerId: this.providerId,
      availability: 'available',
      reason: 'no credential required; configured feeds only',
      checkedAt: new Date().toISOString(),
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}
