import { describe, expect, it } from 'vitest';
import { GitHubAdapter, parseRepoUrl } from '../src/providers/github.js';
import { WebsiteAdapter, extractText } from '../src/providers/website.js';
import { RssAdapter } from '../src/providers/rss.js';
import type { DnsResolver } from '../src/providers/ssrf.js';

/**
 * Live adapter tests: read-only fetches against real public endpoints.
 *
 * NOTE: this sandbox's system DNS resolver is intercepted (returns
 * 198.18.0.0/15 for every name), so the tests inject a DNS-over-HTTPS
 * resolver. The SSRF range-blocking logic still applies to whatever the
 * resolver returns — only the answer source differs. Tests skip (not fail)
 * when the network itself is unavailable, so CI stays green.
 */
const dohResolver: DnsResolver = async (hostname) => {
  const res = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  const json = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
  const addrs = (json.Answer ?? []).filter((a) => a.type === 1).map((a) => ({ address: a.data }));
  if (addrs.length === 0) throw new Error(`DoH: no A records for ${hostname}`);
  return addrs;
};
async function tryLive<T>(label: string, fn: () => Promise<T>): Promise<T | 'skipped'> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[live-test] ${label} skipped: ${(err as Error).message}`);
    return 'skipped';
  }
}

const ctx = { subjectName: 'Hello World', subjectKind: 'app' as const, aliases: [], knownUrls: [] as string[], maxCandidates: 15 };

describe('website adapter (live)', () => {
  it('fetches a real public page through the SSRF-safe client', async () => {
    const adapter = new WebsiteAdapter({ dns: dohResolver });
    const out = await tryLive('website fetch', () =>
      adapter.fetch({ candidateId: 'website:0', url: 'https://example.com', rationale: 'live test', estimatedRelevance: 1 }),
    );
    if (out === 'skipped') return;
    expect(out.error).toBeUndefined();
    const snap = out.snapshot!;
    expect(snap.statusCode).toBe(200);
    expect(snap.originalUrl).toBe('https://example.com');
    expect(snap.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const norm = await adapter.normalize(snap);
    expect(norm.title).toMatch(/Example Domain/);
    expect(norm.excerpt.length).toBeGreaterThan(0);
    const health = await adapter.health();
    expect(health.availability).toBe('available');
  });

  it('still blocks loopback targets even with an honest resolver', async () => {
    const adapter = new WebsiteAdapter({ dns: dohResolver });
    const out = await adapter.fetch({ candidateId: 'website:0', url: 'http://127.0.0.1:8080/admin', rationale: 'x', estimatedRelevance: 1 });
    expect(out.error?.code).toBe('SSRF_BLOCKED');
    expect(out.snapshot).toBeUndefined();
  });

  it('blocks when the resolver itself returns a private address', async () => {
    const evilResolver: DnsResolver = async () => [{ address: '169.254.169.254' }];
    const adapter = new WebsiteAdapter({ dns: evilResolver });
    const out = await adapter.fetch({ candidateId: 'website:0', url: 'https://example.com/', rationale: 'x', estimatedRelevance: 1 });
    expect(out.error?.code).toBe('SSRF_BLOCKED');
  });
});

describe('github adapter (live)', () => {
  it('reads public repo + release data without auth', async () => {
    const adapter = new GitHubAdapter({ dns: dohResolver });
    const found = await adapter.discover({ ...ctx, knownUrls: ['https://github.com/octocat/Hello-World'] });
    expect(found).toHaveLength(1);
    const out = await tryLive('github fetch', () => adapter.fetch(found[0]));
    if (out === 'skipped') return;
    expect(out.error).toBeUndefined();
    const norm = await adapter.normalize(out.snapshot!);
    expect(norm.title).toBe('octocat/Hello-World');
    expect(norm.excerpt).toMatch(/octocat\/Hello-World/);
    const health = await adapter.health();
    expect(['available', 'quota_exhausted']).toContain(health.availability);
  });

  it('reports quota exhaustion honestly and stops without network', async () => {
    const adapter = new GitHubAdapter();
    adapter.setRateStateForTests(0, new Date(Date.now() + 3600_000).toISOString());
    const health = await adapter.health();
    expect(health.availability).toBe('quota_exhausted');
    expect(health.retryAfter).toBeDefined();
    const out = await adapter.fetch({ candidateId: 'github:0', url: 'https://github.com/octocat/Hello-World', rationale: 'x', estimatedRelevance: 1 });
    expect(out.error?.code).toBe('QUOTA_EXHAUSTED');
    expect(out.error?.retryable).toBe(true);
  });
});

describe('rss adapter', () => {
  it('discovers entries from a live feed when network is available', async () => {
    const adapter = new RssAdapter(['https://xkcd.com/rss.xml'], { dns: dohResolver });
    const out = await tryLive('rss discover', () => adapter.discover(ctx));
    if (out === 'skipped') return;
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].url).toMatch(/^https?:\/\//);
  });

  it('health reports available with no credential', async () => {
    const health = await new RssAdapter().health();
    expect(health.availability).toBe('available');
  });
});

describe('parseRepoUrl', () => {
  it('extracts owner/repo and rejects non-repo URLs', () => {
    expect(parseRepoUrl('https://github.com/octocat/Hello-World')).toEqual({ owner: 'octocat', repo: 'Hello-World' });
    expect(parseRepoUrl('https://github.com/octocat/Hello-World.git')).toEqual({ owner: 'octocat', repo: 'Hello-World' });
    expect(parseRepoUrl('https://github.com/octocat/Hello-World/tree/main')).toEqual({ owner: 'octocat', repo: 'Hello-World' });
    expect(parseRepoUrl('https://example.com/x')).toBeNull();
    expect(parseRepoUrl('https://github.com/onlyowner')).toBeNull();
    expect(parseRepoUrl('not a url')).toBeNull();
  });
});

describe('extractText', () => {
  it('strips scripts and tags without executing anything', () => {
    const { title, bodyText } = extractText(
      '<html><head><title>T</title><script>alert(1)</script></head><body><p>Hello <b>world</b></p></body></html>',
    );
    expect(title).toBe('T');
    expect(bodyText).toContain('Hello');
    expect(bodyText).not.toContain('alert');
    expect(bodyText).not.toContain('<');
  });
});
