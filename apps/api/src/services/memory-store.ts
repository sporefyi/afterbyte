/**
 * In-memory ReadStore. Empty by default (honest: no invented production
 * data). With AFTERBYTE_SEED_FIXTURES=1 loads a tiny synthetic fixture set,
 * clearly labelled via dataMode "fixture" at the route layer.
 */
import {
  paginateRows,
  type PageResult,
} from '../lib/pagination.js';
import { createHash } from 'node:crypto';
import type {
  ReadStore,
  DossierSummary,
  DossierDetail,
  ListDossiersOptions,
  PageInput,
  VersionSummary,
  TimelineEvent,
  SourceRecord,
  MetricObservation,
  RelationEdge,
  ChangeEntry,
  CollectionDetail,
  SuggestItem,
  ActivityEvent,
  PublicEventType,
  StatsPayload,
  ReceiptDetail,
  ConfigPayload,
  HomePayload,
  MethodologyPayload,
  StatusPayload,
  SharePayload,
  BookmarkRecord,
  WatchlistRecord,
  NotificationRecord,
  MeProfile,
  SubmissionTicket,
  CorrectionTicket,
} from './store.js';

function page<T>(rows: T[], input: PageInput, ctx: Record<string, string>, idOf: (r: T) => string, keyOf: (r: T) => string): PageResult<T> {
  return paginateRows(rows, { limit: input.limit, cursor: input.cursor }, ctx, idOf, keyOf);
}

export interface MemoryStoreOptions {
  seedFixtures?: boolean;
  config: ConfigPayload;
}

export class MemoryStore implements ReadStore {
  private dossiers = new Map<string, DossierDetail>();
  private timelines = new Map<string, TimelineEvent[]>();
  private sources = new Map<string, SourceRecord[]>();
  private metrics = new Map<string, MetricObservation[]>();
  private relations = new Map<string, RelationEdge[]>();
  private changes = new Map<string, ChangeEntry[]>();
  private versions = new Map<string, VersionSummary[]>();
  private canonicals = new Map<string, { bytes: Buffer; sha256: string }>();
  private collections = new Map<string, CollectionDetail>();
  private receipts = new Map<string, ReceiptDetail>();
  private activity: ActivityEvent[] = [];
  private methodology: MethodologyPayload;
  private statusPayload: StatusPayload;
  private profiles = new Map<string, MeProfile>();
  private bookmarks = new Map<string, Map<string, BookmarkRecord>>();
  private watchlist = new Map<string, Map<string, WatchlistRecord>>();
  private notifications = new Map<string, Map<string, NotificationRecord>>();
  private submissions = new Map<string, SubmissionTicket>();
  private corrections = new Map<string, CorrectionTicket>();
  private ticketSeq = 0;

  constructor(private opts: MemoryStoreOptions) {
    this.methodology = {
      version: '1.0.0',
      updatedAt: '2026-10-16T00:00:00Z',
      sections: [
        { id: 'evidence', heading: 'Evidence standards', body: 'Every factual claim links to a public evidence record.' },
        { id: 'review', heading: 'Editorial review', body: 'Two-reviewer sign-off before publication.' },
      ],
    };
    this.statusPayload = {
      status: 'operational',
      asOf: new Date().toISOString(),
      components: [
        { name: 'api', status: 'operational', detail: 'Serving requests' },
        { name: 'read-models', status: 'operational', detail: 'Memory store' },
      ],
    };
    if (opts.seedFixtures) this.seed();
  }

  get isFixtureMode(): boolean {
    return !!this.opts.seedFixtures;
  }

  // ---- public reads ----

  getConfig(): ConfigPayload {
    return this.opts.config;
  }

  getHome(): HomePayload {
    const featured = [...this.dossiers.values()].slice(0, 4).map(toSummary);
    const stats = this.getStats();
    return {
      editionId: '00000000-0000-4000-8000-000000000001',
      headline: 'The internet moves on. We follow up.',
      featured,
      recentChanges: [...this.changes.values()].flat().slice(0, 5),
      stillAlive: [...this.dossiers.values()].filter((d) => d.lifecycleStatus === 'active').map(toSummary),
      researchFeedPreview: [],
      stats,
    };
  }

  getStats(): StatsPayload {
    const all = [...this.dossiers.values()];
    const byLifecycle = { active: 0, declining: 0, uncertain: 0, dormant: 0, defunct: 0 } as StatsPayload['byLifecycle'];
    const byCategory = { app: 0, website: 0, game: 0, meme: 0, community: 0, crypto: 0 } as StatsPayload['byCategory'];
    for (const d of all) {
      byLifecycle[d.lifecycleStatus]++;
      byCategory[d.category]++;
    }
    return {
      archiveCount: all.length,
      activeCount: byLifecycle.active,
      recordedCount: [...this.receipts.values()].filter((r) => r.status === 'finalized').length,
      byLifecycle,
      byCategory,
      asOf: new Date().toISOString(),
      definitions: {
        archiveCount: 'Non-retracted published subjects.',
        activeCount: 'Subjects whose current reviewed status is active.',
        recordedCount: 'Versions with finalized receipts.',
      },
    };
  }

  listDossiers(opts: ListDossiersOptions): { items: DossierSummary[]; nextCursor: string | null } {
    let rows = [...this.dossiers.values()].map(toSummary);
    if (opts.category) rows = rows.filter((r) => r.category === opts.category);
    if (opts.lifecycleStatus) rows = rows.filter((r) => r.lifecycleStatus === opts.lifecycleStatus);
    if (opts.q) {
      const q = opts.q.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.summary.toLowerCase().includes(q));
    }
    const keyOf = (r: DossierSummary): string => {
      if (opts.sort === 'recently_updated' || opts.sort === 'recently_verified') return r.lastReviewedAt ?? r.publishedAt;
      return r.publishedAt;
    };
    rows.sort((a, b) => (keyOf(b) < keyOf(a) ? -1 : keyOf(b) > keyOf(a) ? 1 : a.id < b.id ? -1 : 1));
    // paginateRows expects ascending; reverse, paginate, reverse back
    const asc = [...rows].reverse();
    const ctx: Record<string, string> = {
      sort: opts.sort,
      category: opts.category ?? '',
      lifecycleStatus: opts.lifecycleStatus ?? '',
      q: opts.q ?? '',
      era: opts.era ?? '',
    };
    const res = paginateRows(asc, { limit: opts.limit, cursor: opts.cursor }, ctx, (r) => r.id, keyOf);
    return { items: [...res.items].reverse(), nextCursor: res.nextCursor };
  }

  getDossier(slug: string): DossierDetail | null {
    return this.dossiers.get(slug) ?? null;
  }

  listVersions(slug: string, input: PageInput) {
    const rows = this.versions.get(slug);
    if (!rows) return null;
    const sorted = [...rows].sort((a, b) => a.version - b.version);
    const res = page(sorted, input, { slug }, (r) => String(r.version), (r) => String(r.version).padStart(10, '0'));
    return res;
  }

  getVersion(slug: string, version: number): DossierDetail | null {
    const d = this.dossiers.get(slug);
    if (!d) return null;
    const v = (this.versions.get(slug) ?? []).find((x) => x.version === version);
    if (!v) return null;
    return { ...d, version };
  }

  getCanonical(slug: string, version: number): { bytes: Buffer; sha256: string } | null {
    return this.canonicals.get(`${slug}:v${version}`) ?? null;
  }

  listTimeline(slug: string, input: PageInput) {
    const rows = this.timelines.get(slug);
    if (!rows) return null;
    const sorted = [...rows].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1));
    return page(sorted, input, { slug }, (r) => r.id, (r) => r.occurredAt);
  }

  listSources(slug: string, input: PageInput) {
    const rows = this.sources.get(slug);
    if (!rows) return null;
    const sorted = [...rows].sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.id < b.id ? -1 : 1));
    return page(sorted, input, { slug }, (r) => r.id, (r) => r.addedAt);
  }

  listMetrics(slug: string, input: PageInput) {
    const rows = this.metrics.get(slug);
    if (!rows) return null;
    const sorted = [...rows].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id < b.id ? -1 : 1));
    return page(sorted, input, { slug }, (r) => r.id, (r) => r.observedAt);
  }

  listRelations(slug: string, input: PageInput) {
    const rows = this.relations.get(slug);
    if (!rows) return null;
    const sorted = [...rows].sort((a, b) => (a.targetSlug < b.targetSlug ? -1 : a.targetSlug > b.targetSlug ? 1 : a.id < b.id ? -1 : 1));
    return page(sorted, input, { slug }, (r) => r.id, (r) => r.targetSlug);
  }

  listChanges(slug: string, input: PageInput) {
    const rows = this.changes.get(slug);
    if (!rows) return null;
    const sorted = [...rows].sort((a, b) => (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : a.id < b.id ? -1 : 1));
    return page(sorted, input, { slug }, (r) => r.id, (r) => r.changedAt);
  }

  getCollection(slug: string): CollectionDetail | null {
    return this.collections.get(slug) ?? null;
  }

  suggest(q: string, limit: number): SuggestItem[] {
    const needle = q.toLowerCase();
    return [...this.dossiers.values()]
      .filter((d) => d.name.toLowerCase().includes(needle) || d.slug.includes(needle))
      .slice(0, limit)
      .map((d) => ({ slug: d.slug, name: d.name, category: d.category }));
  }

  listActivity(input: PageInput, eventType?: PublicEventType) {
    let rows = [...this.activity].sort((a, b) =>
      a.sequenceId < b.sequenceId ? -1 : a.sequenceId > b.sequenceId ? 1 : 0,
    );
    if (eventType) rows = rows.filter((e) => e.eventType === eventType);
    return page(rows, input, { eventType: eventType ?? '' }, (r) => r.eventId, (r) => r.sequenceId.padStart(20, '0'));
  }

  getReceipt(id: string): ReceiptDetail | null {
    return this.receipts.get(id) ?? null;
  }

  getMethodology(): MethodologyPayload {
    return this.methodology;
  }

  getStatus(): StatusPayload {
    return { ...this.statusPayload, asOf: new Date().toISOString() };
  }

  getShare(slug: string, version: number): SharePayload | null {
    const d = this.dossiers.get(slug);
    if (!d) return null;
    const v = (this.versions.get(slug) ?? []).find((x) => x.version === version);
    if (!v) return null;
    return {
      slug,
      version,
      title: `${d.name} — version ${version}`,
      imageUrl: null,
      metadata: { description: d.summary },
    };
  }

  // ---- personal ----

  getOrCreateProfile(userId: string, address: string): MeProfile {
    let p = this.profiles.get(userId);
    if (!p) {
      p = { userId, address, roles: ['reader'], capabilities: [], createdAt: new Date().toISOString() };
      this.profiles.set(userId, p);
    }
    return p;
  }

  private userMap<K>(m: Map<string, Map<string, K>>, userId: string): Map<string, K> {
    let inner = m.get(userId);
    if (!inner) {
      inner = new Map();
      m.set(userId, inner);
    }
    return inner;
  }

  listBookmarks(userId: string): BookmarkRecord[] {
    return [...this.userMap(this.bookmarks, userId).values()];
  }
  putBookmark(userId: string, subjectId: string, dossierSlug: string): BookmarkRecord {
    const rec = { subjectId, dossierSlug, createdAt: new Date().toISOString() };
    this.userMap(this.bookmarks, userId).set(subjectId, rec);
    return rec;
  }
  deleteBookmark(userId: string, subjectId: string): boolean {
    return this.userMap(this.bookmarks, userId).delete(subjectId);
  }
  listWatchlist(userId: string): WatchlistRecord[] {
    return [...this.userMap(this.watchlist, userId).values()];
  }
  putWatchlist(userId: string, subjectId: string, dossierSlug: string): WatchlistRecord {
    const rec = { subjectId, dossierSlug, createdAt: new Date().toISOString() };
    this.userMap(this.watchlist, userId).set(subjectId, rec);
    return rec;
  }
  deleteWatchlist(userId: string, subjectId: string): boolean {
    return this.userMap(this.watchlist, userId).delete(subjectId);
  }
  listNotifications(userId: string): NotificationRecord[] {
    return [...this.userMap(this.notifications, userId).values()];
  }
  markNotificationRead(userId: string, id: string): NotificationRecord | null {
    const n = this.userMap(this.notifications, userId).get(id);
    if (!n) return null;
    n.read = true;
    return n;
  }
  createSubmission(userId: string, input: { subjectName: string; candidateUrls: string[]; reason: string }): SubmissionTicket {
    const id = `sub-${++this.ticketSeq}`;
    const t: SubmissionTicket = { id, userId, status: 'open', createdAt: new Date().toISOString(), ...input };
    this.submissions.set(id, t);
    return t;
  }
  createCorrection(userId: string, dossierSlug: string, input: { claimedIssue: string; evidenceUrls: string[]; explanatoryText: string }): CorrectionTicket {
    const id = `cor-${++this.ticketSeq}`;
    const t: CorrectionTicket = { id, userId, dossierSlug, status: 'open', createdAt: new Date().toISOString(), ...input };
    this.corrections.set(id, t);
    return t;
  }
  listMySubmissions(userId: string): SubmissionTicket[] {
    return [...this.submissions.values()].filter((s) => s.userId === userId);
  }
  listMyOrders(_userId: string): unknown[] {
    return [];
  }

  private seed(): void {
    const d1: DossierDetail = {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'example-project',
      name: 'Example Project',
      category: 'website',
      version: 2,
      summary: 'A reviewed, cited summary of a synthetic fixture dossier.',
      lifecycleStatus: 'uncertain',
      publishedAt: '2026-10-10T08:00:00Z',
      lastReviewedAt: '2026-10-15T07:30:00Z',
      sourceCount: 3,
      statusReason: 'Current operation could not be independently established.',
      evidenceAssessment: { band: 'limited', reason: 'Coverage is incomplete.' },
      lastObservedAt: '2026-10-15T07:00:00Z',
      nextReviewAt: '2026-10-22T07:30:00Z',
      heroAsset: null,
      sections: [{ id: 'origin', heading: 'Where it began', blocks: [] }],
      timelinePreview: [{ id: 't1', occurredAt: '2020-01-01T00:00:00Z', title: 'Launch' }],
      proof: { status: 'pending', receiptId: null, signature: null },
      availableMetrics: ['monthly_visits'],
      relationsPreview: [],
    };
    this.dossiers.set(d1.slug, d1);
    this.timelines.set(d1.slug, [
      { id: 't1', occurredAt: '2020-01-01T00:00:00Z', datePrecision: 'day', title: 'Launch', type: 'milestone', description: 'Synthetic fixture event.', sources: [] },
    ]);
    this.sources.set(d1.slug, [
      { id: 's1', url: 'https://example.com/launch', title: 'Launch announcement', addedAt: '2026-10-10T08:00:00Z', archived: true, excerpt: 'Synthetic fixture excerpt.' },
    ]);
    this.metrics.set(d1.slug, [
      { id: 'm1', metricKey: 'monthly_visits', value: '12000', unit: 'visits/month', observedAt: '2026-10-01T00:00:00Z', source: 'fixture', coverageStart: '2026-09-01T00:00:00Z', coverageEnd: '2026-10-01T00:00:00Z' },
    ]);
    this.relations.set(d1.slug, []);
    this.changes.set(d1.slug, [
      { id: 'c1', version: 2, changedAt: '2026-10-15T07:30:00Z', changeType: 'correction', explanation: 'Fixed launch date.', diff: [{ path: 'timeline[0].occurredAt', before: '2020-02-01', after: '2020-01-01' }] },
    ]);
    this.versions.set(d1.slug, [
      { version: 1, publishedAt: '2026-10-10T08:00:00Z', changeCount: 0, summary: 'Initial publication.', label: 'published' },
      { version: 2, publishedAt: '2026-10-15T07:30:00Z', changeCount: 1, summary: 'Launch date corrected.', label: 'correction' },
    ]);
    const canon = Buffer.from(JSON.stringify({ schemaVersion: 1, subjectId: d1.id, versionNumber: 2 }), 'utf8');
    this.canonicals.set(`${d1.slug}:v2`, { bytes: canon, sha256: createHash('sha256').update(canon).digest('hex') });
    this.collections.set('still-alive', {
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'still-alive',
      name: 'Still Alive',
      description: 'Reviewed selections that are still operating.',
      dossierCount: 0,
      dossiers: [],
    });
    this.activity.push({
      eventId: '33333333-3333-4333-8333-333333333333',
      sequenceId: '1',
      eventType: 'dossier.published',
      occurredAt: '2026-10-10T08:00:00Z',
      subjectId: d1.id,
      dossierVersion: 1,
      aggregateRevision: 1,
      payload: { slug: d1.slug },
    });
  }
}

function toSummary(d: DossierDetail): DossierSummary {
  const { id, slug, name, category, version, summary, lifecycleStatus, publishedAt, lastReviewedAt, sourceCount } = d;
  return { id, slug, name, category, version, summary, lifecycleStatus, publishedAt, lastReviewedAt, sourceCount };
}
