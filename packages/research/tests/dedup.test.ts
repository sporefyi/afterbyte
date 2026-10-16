import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  countIndependentSources,
  dedupeByContent,
  findDuplicateSubjects,
  normalizeSubjectName,
  registrableDomain,
  urlFingerprint,
} from '../src/dedup.js';

describe('canonicalizeUrl', () => {
  it('strips tracking params, fragments, and default ports', () => {
    expect(canonicalizeUrl('https://Example.COM:443/a?utm_source=x&b=1#frag')).toBe('https://example.com/a?b=1');
    expect(canonicalizeUrl('http://example.com:80/')).toBe('http://example.com');
  });

  it('sorts query params for stable identity', () => {
    expect(canonicalizeUrl('https://e.com/?b=2&a=1')).toBe(canonicalizeUrl('https://e.com/?a=1&b=2'));
  });

  it('never throws on garbage', () => {
    expect(() => canonicalizeUrl(':::')).not.toThrow();
  });
});

describe('dedupeByContent (syndication)', () => {
  const mk = (snapshotId: string, url: string, contentHash: string) => ({
    snapshotId,
    url,
    contentHash,
    fetchedAt: '2026-10-16T00:00:00Z',
  });

  it('two copies of one article on different domains count as ONE independent source', () => {
    const groups = dedupeByContent([
      mk('s1', 'https://news-a.com/story', 'hash1'),
      mk('s2', 'https://news-b.com/story', 'hash1'), // syndicated copy
      mk('s3', 'https://blog-c.com/other', 'hash2'),
    ]);
    expect(groups).toHaveLength(2);
    const synd = groups.find((g) => g.syndicated)!;
    expect(synd.memberSnapshotIds).toEqual(['s1', 's2']);
    expect(synd.domains.sort()).toEqual(['news-a.com', 'news-b.com']);
    expect(synd.independentSourceCount).toBe(1);
    // Syndication must not boost independence: 3 fetches → 2 independent sources.
    expect(countIndependentSources(groups)).toBe(2);
  });

  it('identical URLs on the same domain are not labelled syndicated', () => {
    const groups = dedupeByContent([
      mk('s1', 'https://a.com/x', 'h'),
      mk('s2', 'https://a.com/x?ref=1', 'h'),
    ]);
    expect(groups[0].syndicated).toBe(false);
  });
});

describe('duplicate-subject detection', () => {
  it('normalizes names for comparison', () => {
    expect(normalizeSubjectName('The Official FooApp')).toBe('fooapp');
    expect(normalizeSubjectName('Café Chat')).toBe('cafe chat');
  });

  it('matches a duplicate by normalized name', () => {
    const matches = findDuplicateSubjects('FooApp Official', [], [
      { subjectId: 'sub_9', name: 'FooApp', aliases: [], urls: [] },
    ]);
    expect(matches[0].subjectId).toBe('sub_9');
    expect(matches[0].score).toBeGreaterThanOrEqual(0.5);
  });

  it('matches a duplicate by canonical URL despite tracking params', () => {
    const matches = findDuplicateSubjects('Something Else', ['https://foo.app/?utm_source=x'], [
      { subjectId: 'sub_9', name: 'FooApp', aliases: [], urls: ['https://foo.app/'] },
    ]);
    expect(matches).toHaveLength(0); // name differs, but URL matches → score 0.4 < 0.5
    const strong = findDuplicateSubjects('FooApp', ['https://foo.app/?utm_source=x'], [
      { subjectId: 'sub_9', name: 'FooApp', aliases: [], urls: ['https://foo.app/'] },
    ]);
    expect(strong[0].score).toBeGreaterThanOrEqual(0.8);
    expect(strong[0].reasons.join(' ')).toMatch(/URL fingerprint/);
  });

  it('urlFingerprint is stable across tracking-param variants', () => {
    expect(urlFingerprint('https://e.com/a?utm_source=x')).toBe(urlFingerprint('https://e.com/a'));
  });

  it('registrableDomain is a documented naive approximation', () => {
    expect(registrableDomain('news.a.com')).toBe('a.com');
  });
});
