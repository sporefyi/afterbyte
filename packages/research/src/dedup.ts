/**
 * Provenance / syndication dedup + duplicate-subject detection (brief §7).
 *
 * Two copies of one article must not count as two independent sources:
 * sources are grouped by content hash, and a group spanning multiple
 * registrable domains is marked syndicated (one independent source, not N).
 */
import { createHash } from 'node:crypto';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'igshid', 'ref', 'referrer', 'mc_cid', 'mc_eid',
]);

/** Canonical URL for identity comparison. Never throws. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    const params = new URLSearchParams();
    const keys = [...u.searchParams.keys()].sort();
    for (const k of keys) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
      for (const v of u.searchParams.getAll(k)) params.append(k, v);
    }
    u.search = params.toString();
    let s = u.toString();
    if (s.endsWith('/') && u.pathname === '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** SHA-256 of the canonical URL. */
export function urlFingerprint(raw: string): string {
  return createHash('sha256').update(canonicalizeUrl(raw)).digest('hex');
}

/** Naive registrable domain (last two labels). Documented approximation. */
export function registrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

export interface DedupSource {
  snapshotId: string;
  url: string;
  contentHash: string;
  fetchedAt: string;
}

export interface SourceGroup {
  /** Representative snapshot id. */
  snapshotId: string;
  memberSnapshotIds: string[];
  /** Distinct registrable domains in the group. */
  domains: string[];
  /** True when the same bytes appeared on >1 domain: syndicated, not independent. */
  syndicated: boolean;
  /** 1 when syndicated (counts once), else member count. */
  independentSourceCount: number;
  canonicalUrl: string;
}

/**
 * Group sources by content hash. A group with the same hash on multiple
 * domains is syndication — it contributes ONE independent source.
 */
export function dedupeByContent(sources: DedupSource[]): SourceGroup[] {
  const byHash = new Map<string, DedupSource[]>();
  for (const s of sources) {
    const list = byHash.get(s.contentHash) ?? [];
    list.push(s);
    byHash.set(s.contentHash, list);
  }
  const groups: SourceGroup[] = [];
  for (const members of byHash.values()) {
    members.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
    const domains = [...new Set(members.map((m) => {
      try {
        return registrableDomain(new URL(m.url).hostname);
      } catch {
        return m.url;
      }
    }))];
    const syndicated = domains.length > 1;
    groups.push({
      snapshotId: members[0].snapshotId,
      memberSnapshotIds: members.map((m) => m.snapshotId),
      domains,
      syndicated,
      independentSourceCount: syndicated ? 1 : members.length,
      canonicalUrl: canonicalizeUrl(members[0].url),
    });
  }
  return groups;
}

/** Total independent sources across groups (syndicated groups count once). */
export function countIndependentSources(groups: SourceGroup[]): number {
  return groups.reduce((n, g) => n + g.independentSourceCount, 0);
}

/* ------------------------------------------------------------------ */
/* Duplicate-subject detection on ingest                               */
/* ------------------------------------------------------------------ */

/** Normalize a subject name for comparison. */
export function normalizeSubjectName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|app|official|hq|inc|llc|ltd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SubjectCandidate {
  subjectId: string;
  name: string;
  aliases: string[];
  urls: string[];
}

export interface DuplicateMatch {
  subjectId: string;
  score: number; // 0..1
  reasons: string[];
}

/**
 * Score a candidate name/URL set against an existing subject.
 * Score >= 0.8 is a strong duplicate signal (caller decides the action).
 */
export function scoreDuplicateSubject(
  name: string,
  urls: string[],
  existing: SubjectCandidate,
): DuplicateMatch {
  const reasons: string[] = [];
  let score = 0;
  const normName = normalizeSubjectName(name);
  const normExisting = [existing.name, ...existing.aliases].map(normalizeSubjectName);
  if (normName && normExisting.includes(normName)) {
    score += 0.6;
    reasons.push('normalized name matches name/alias');
  } else if (normName) {
    // Token overlap fallback.
    const a = new Set(normName.split(' '));
    const best = Math.max(
      ...normExisting.map((e) => {
        const b = new Set(e.split(' '));
        const inter = [...a].filter((t) => b.has(t)).length;
        return inter / Math.max(a.size, b.size);
      }),
      0,
    );
    if (best >= 0.6) {
      score += 0.3 * best;
      reasons.push(`name token overlap ${(best * 100).toFixed(0)}%`);
    }
  }
  const fp = new Set(urls.map(urlFingerprint));
  const efp = new Set(existing.urls.map(urlFingerprint));
  const urlHits = [...fp].filter((f) => efp.has(f)).length;
  if (urlHits > 0) {
    score += 0.4;
    reasons.push(`${urlHits} canonical URL fingerprint(s) match`);
  }
  return { subjectId: existing.subjectId, score: Math.min(1, score), reasons };
}

/** Find existing subjects that may duplicate the candidate (score >= 0.5). */
export function findDuplicateSubjects(
  name: string,
  urls: string[],
  existing: SubjectCandidate[],
): DuplicateMatch[] {
  return existing
    .map((e) => scoreDuplicateSubject(name, urls, e))
    .filter((m) => m.score >= 0.5)
    .sort((a, b) => b.score - a.score);
}
