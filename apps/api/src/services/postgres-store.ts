/**
 * Postgres-backed ReadStore (Drizzle). Used when DATABASE_URL is set; the
 * MemoryStore remains the fallback for dev/test without a database.
 *
 * Mapping notes (all verified against packages/database/src/schema):
 * - subjects + dossier_versions.currentPublishedVersionId form a "dossier".
 *   Only visibility='public' subjects with a 'published' (non-retracted)
 *   current version are served publicly — retracted/unlisted content is
 *   excluded from public reads per brief §5.
 * - Category: subject_kind 'crypto_project' -> 'crypto'. Kind 'other' has no
 *   public-contract equivalent; it is passed through honestly (documented
 *   contract gap — the OpenAPI Category enum should gain 'other') rather
 *   than mislabeled or hidden.
 * - Lifecycle: discontinued -> 'defunct', revived -> 'active' (the reason
 *   text is preserved on statusReason). The public type has no 'revived'
 *   and no 'declining'; 'declining' can never match a DB row.
 * - Proof: submitted/confirmed/unavailable -> 'pending' (not yet finalized),
 *   finalized -> 'anchored', failed -> 'failed'. A receipt row may not exist
 *   yet -> 'pending' with null ids.
 * - Sections come from the subject's latest draft structuredContent; the
 *   byte-exact canonical payload lives in object storage (see getCanonical).
 * - Approximate dates are passed through as stored (brief §4: never
 *   manufacture a precise day from a year-only source).
 * - getCanonical / receipt canonicalBundleUrl require object storage; they
 *   degrade honestly (null / 404) when storage is unconfigured.
 * - There is no editorial-collections table in the schema, so getCollection
 *   returns null (documented schema gap) instead of inventing a collection.
 * - Money stays integer-string (numeric columns); dates are ISO-8601 UTC.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Db } from '@afterbyte/database';
import {
  activityEvents,
  bookmarks,
  claims,
  claimEvidence,
  corrections,
  dossierDrafts,
  dossierVersions,
  featuredItems,
  homeEditions,
  notifications,
  observations,
  publicationReceipts,
  roleGrants,
  sources,
  sourceSnapshots,
  subjects,
  subjectRelations,
  submissions,
  timelineEvents,
  users,
  walletIdentities,
  watchlists,
  watchlistItems,
} from '@afterbyte/database';
import type { StorageClient } from '@afterbyte/storage';
import {
  decodeCursor,
  encodeCursor,
  normalizeLimit,
  paginateRows,
} from '../lib/pagination.js';
import type {
  ActivityEvent,
  BookmarkRecord,
  Category,
  ChangeEntry,
  CollectionDetail,
  ConfigPayload,
  DossierDetail,
  DossierSummary,
  EvidenceBand,
  HomePayload,
  LifecycleStatus,
  ListDossiersOptions,
  MeProfile,
  MetricObservation,
  MethodologyPayload,
  NotificationRecord,
  PageInput,
  ProofStatus,
  PublicEventType,
  ReadStore,
  ReceiptDetail,
  RelationEdge,
  SharePayload,
  SourceRecord,
  StatsPayload,
  StatusPayload,
  SubmissionTicket,
  CorrectionTicket,
  SuggestItem,
  TimelineEvent,
  VersionSummary,
  WatchlistRecord,
} from './store.js';

type SubjectRow = typeof subjects.$inferSelect;
type VersionRow = typeof dossierVersions.$inferSelect;

export interface PostgresStoreOptions {
  config: ConfigPayload;
  /** When null/omitted, canonical bytes and bundle URLs degrade honestly. */
  storage?: StorageClient | null;
}

/* ------------------------------------------------------------------ */
/* value mappings                                                       */
/* ------------------------------------------------------------------ */

function toCategory(kind: SubjectRow['kind']): Category {
  if (kind === 'crypto_project') return 'crypto';
  if (kind === 'other') {
    // Documented contract gap (see file header): pass through honestly.
    return 'other' as Category;
  }
  return kind;
}

function fromCategory(category: Category): SubjectRow['kind'] {
  return category === 'crypto' ? 'crypto_project' : (category as SubjectRow['kind']);
}

function toLifecycleStatus(status: VersionRow['lifecycleStatus']): LifecycleStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'dormant':
      return 'dormant';
    case 'discontinued':
      return 'defunct';
    case 'revived':
      return 'active'; // no public 'revived'; reason text is preserved
    case 'uncertain':
    default:
      return 'uncertain';
  }
}

/** DB lifecycle values backing one public filter value (null = unmatchable). */
function lifecycleFilterValues(filter: LifecycleStatus): VersionRow['lifecycleStatus'][] | null {
  switch (filter) {
    case 'active':
      return ['active', 'revived'];
    case 'dormant':
      return ['dormant'];
    case 'uncertain':
      return ['uncertain'];
    case 'defunct':
      return ['discontinued'];
    case 'declining':
      return []; // no DB representation -> empty result, never an error
  }
}

function toProofStatus(status: string): ProofStatus {
  if (status === 'finalized') return 'anchored';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function toDatePrecision(p: string | null): TimelineEvent['datePrecision'] {
  if (p === 'day' || p === 'month' || p === 'year') return p;
  return 'year'; // 'approximate' and null: never invent finer precision
}

function toEvidenceBand(
  band: VersionRow['confidenceBand'],
  reason: string | null,
): DossierDetail['evidenceAssessment'] {
  if (!band) return null;
  const b = band as EvidenceBand; // strong | moderate | limited (schema-closed)
  return { band: b, reason: reason ?? '' };
}

function confidenceToStrength(confidence: string | null): RelationEdge['strength'] {
  const c = confidence === null ? NaN : Number.parseFloat(confidence);
  if (Number.isNaN(c)) return 'weak';
  if (c >= 0.75) return 'strong';
  if (c >= 0.4) return 'moderate';
  return 'weak';
}

function toTicketStatus(moderationState: string): 'open' | 'accepted' | 'rejected' {
  if (moderationState === 'approved') return 'accepted';
  if (moderationState === 'rejected') return 'rejected';
  return 'open'; // pending | needs_info
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function validCursorDate(k: string): boolean {
  return !Number.isNaN(Date.parse(k));
}

function invalidCursor(): Error {
  return Object.assign(new Error('invalid cursor'), { code: 'VALIDATION_FAILED' });
}

/* ------------------------------------------------------------------ */
/* store                                                                */
/* ------------------------------------------------------------------ */

export class PostgresStore implements ReadStore {
  constructor(
    private db: Db,
    private opts: PostgresStoreOptions,
  ) {}

  private get storage(): StorageClient | null {
    return this.opts.storage ?? null;
  }

  /* ---------------- public reads ---------------- */

  async getConfig(): Promise<ConfigPayload> {
    return this.opts.config;
  }

  async getHome(): Promise<HomePayload> {
    const editionRows = await this.db
      .select()
      .from(homeEditions)
      .where(eq(homeEditions.state, 'published'))
      .orderBy(desc(homeEditions.editionDate))
      .limit(1);
    const edition = editionRows[0] ?? null;

    let featured: DossierSummary[] = [];
    if (edition) {
      const rows = await this.db
        .select({ subject: subjects, version: dossierVersions })
        .from(featuredItems)
        .innerJoin(subjects, eq(subjects.id, featuredItems.subjectId))
        .innerJoin(dossierVersions, eq(dossierVersions.id, subjects.currentPublishedVersionId))
        .where(
          and(
            eq(featuredItems.homeEditionId, edition.id),
            eq(subjects.visibility, 'public'),
            eq(dossierVersions.publicationState, 'published'),
          ),
        )
        .orderBy(asc(featuredItems.position))
        .limit(8);
      const counts = await this.sourceCounts(rows.map((r) => r.version.id));
      featured = rows.map((r) => this.toSummary(r.subject, r.version, counts.get(r.version.id) ?? 0));
    }

    const [recentChanges, stillAlive, stats] = await Promise.all([
      this.recentChanges(5),
      this.stillAliveSummaries(12),
      this.getStats(),
    ]);

    return {
      editionId: edition?.id ?? '00000000-0000-0000-0000-000000000000',
      headline: edition?.title ?? 'The internet moves on. We follow up.',
      featured,
      recentChanges,
      stillAlive,
      researchFeedPreview: [],
      stats,
    };
  }

  async getStats(): Promise<StatsPayload> {
    const base = and(
      eq(subjects.visibility, 'public'),
      eq(dossierVersions.publicationState, 'published'),
    );
    const [archiveRows, lifeRows, catRows, recordedRows] = await Promise.all([
      this.db
        .select({ n: count() })
        .from(subjects)
        .innerJoin(dossierVersions, eq(dossierVersions.id, subjects.currentPublishedVersionId))
        .where(base),
      this.db
        .select({ status: dossierVersions.lifecycleStatus, n: count() })
        .from(subjects)
        .innerJoin(dossierVersions, eq(dossierVersions.id, subjects.currentPublishedVersionId))
        .where(base)
        .groupBy(dossierVersions.lifecycleStatus),
      this.db
        .select({ kind: subjects.kind, n: count() })
        .from(subjects)
        .innerJoin(dossierVersions, eq(dossierVersions.id, subjects.currentPublishedVersionId))
        .where(base)
        .groupBy(subjects.kind),
      this.db
        .select({ n: count() })
        .from(publicationReceipts)
        .where(eq(publicationReceipts.status, 'finalized')),
    ]);

    const byLifecycle: StatsPayload['byLifecycle'] = {
      active: 0,
      declining: 0,
      uncertain: 0,
      dormant: 0,
      defunct: 0,
    };
    for (const r of lifeRows) {
      const mapped = toLifecycleStatus(r.status);
      byLifecycle[mapped] += r.n;
    }
    const byCategory: StatsPayload['byCategory'] = {
      app: 0,
      website: 0,
      game: 0,
      meme: 0,
      community: 0,
      crypto: 0,
    };
    for (const r of catRows) {
      const c = toCategory(r.kind);
      if (c in byCategory) byCategory[c as keyof typeof byCategory] += r.n;
      // 'other' has no public bucket; counted in archiveCount only (documented gap)
    }

    return {
      archiveCount: archiveRows[0]?.n ?? 0,
      activeCount: byLifecycle.active,
      recordedCount: recordedRows[0]?.n ?? 0,
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

  /* ---------------- dossier reads ---------------- */

  private toSummary(s: SubjectRow, v: VersionRow, sourceCount: number): DossierSummary {
    return {
      id: s.id,
      slug: s.slug,
      name: s.canonicalName,
      category: toCategory(s.kind),
      version: v.versionNumber,
      summary: s.shortDescription ?? '',
      lifecycleStatus: toLifecycleStatus(v.lifecycleStatus),
      publishedAt: iso(v.publishedAt ?? v.createdAt) ?? new Date(0).toISOString(),
      lastReviewedAt: iso(v.reviewedAt),
      sourceCount,
    };
  }

  /** Public subject + its current published version, or null. */
  private async subjectWithVersion(
    slug: string,
  ): Promise<{ subject: SubjectRow; version: VersionRow } | null> {
    const rows = await this.db
      .select({ subject: subjects, version: dossierVersions })
      .from(subjects)
      .innerJoin(dossierVersions, eq(dossierVersions.id, subjects.currentPublishedVersionId))
      .where(
        and(
          eq(subjects.slug, slug),
          eq(subjects.visibility, 'public'),
          eq(dossierVersions.publicationState, 'published'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async sourceCounts(versionIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (versionIds.length === 0) return counts;
    const rows = await this.db
      .select({ versionId: claims.containerId, sourceId: sources.id })
      .from(claims)
      .innerJoin(claimEvidence, eq(claimEvidence.claimId, claims.id))
      .innerJoin(sourceSnapshots, eq(sourceSnapshots.id, claimEvidence.sourceSnapshotId))
      .innerJoin(sources, eq(sources.id, sourceSnapshots.sourceId))
      .where(
        and(eq(claims.containerKind, 'version'), inArray(claims.containerId, versionIds)),
      );
    const seen = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = seen.get(r.versionId);
      if (!set) {
        set = new Set();
        seen.set(r.versionId, set);
      }
      set.add(r.sourceId);
    }
    for (const [k, v] of seen) counts.set(k, v.size);
    return counts;
  }

  private async latestDraftSections(
    subjectId: string,
  ): Promise<{ id: string; heading: string; blocks: unknown[] }[]> {
    const rows = await this.db
      .select({ content: dossierDrafts.structuredContent })
      .from(dossierDrafts)
      .where(eq(dossierDrafts.subjectId, subjectId))
      .orderBy(desc(dossierDrafts.updatedAt))
      .limit(1);
    const c = rows[0]?.content as {
      sections?: { id: string; heading: string; blocks: unknown[] }[];
    } | null;
    return Array.isArray(c?.sections) ? c.sections : [];
  }

  private async toDetail(s: SubjectRow, v: VersionRow): Promise<DossierDetail> {
    const [sections, timelineRows, receiptRows, metricRows, relationRows, observedRows, counts] =
      await Promise.all([
        this.latestDraftSections(s.id),
        this.db
          .select()
          .from(timelineEvents)
          .where(
            and(
              eq(timelineEvents.subjectId, s.id),
              eq(timelineEvents.containerKind, 'version'),
              eq(timelineEvents.containerId, v.id),
            ),
          )
          .orderBy(asc(timelineEvents.displayOrder), asc(timelineEvents.id))
          .limit(5),
        this.db
          .select()
          .from(publicationReceipts)
          .where(eq(publicationReceipts.versionId, v.id))
          .limit(1),
        this.db
          .selectDistinct({ metricName: observations.metricName })
          .from(observations)
          .where(eq(observations.subjectId, s.id)),
        this.db
          .select({ rel: subjectRelations, target: subjects })
          .from(subjectRelations)
          .innerJoin(subjects, eq(subjects.id, subjectRelations.toSubjectId))
          .where(eq(subjectRelations.fromSubjectId, s.id))
          .orderBy(asc(subjects.slug))
          .limit(10),
        this.db
          .select({ observedAt: observations.observedAt })
          .from(observations)
          .where(eq(observations.subjectId, s.id))
          .orderBy(desc(observations.observedAt))
          .limit(1),
        this.sourceCounts([v.id]),
      ]);

    const receipt = receiptRows[0] ?? null;
    let lastObservedAt: string | null = null;
    if (observedRows[0]?.observedAt) lastObservedAt = observedRows[0].observedAt.toISOString();

    return {
      ...this.toSummary(s, v, counts.get(v.id) ?? 0),
      statusReason: v.statusReason,
      evidenceAssessment: toEvidenceBand(v.confidenceBand, v.confidenceReason),
      lastObservedAt,
      nextReviewAt: iso(v.nextReviewAt),
      heroAsset: null, // no subject<->asset link in schema; honest null
      sections,
      timelinePreview: timelineRows.map((t) => ({
        id: t.id,
        occurredAt: t.dateStart ?? '',
        title: t.title,
      })),
      proof: receipt
        ? { status: toProofStatus(receipt.status), receiptId: receipt.id, signature: receipt.signature }
        : { status: 'pending', receiptId: null, signature: null },
      availableMetrics: metricRows.map((m) => m.metricName),
      relationsPreview: relationRows.map((r) => ({
        slug: r.target.slug,
        name: r.target.canonicalName,
        relationshipType: r.rel.relationshipType,
      })),
    };
  }

  async listDossiers(
    opts: ListDossiersOptions,
  ): Promise<{ items: DossierSummary[]; nextCursor: string | null }> {
    const limit = normalizeLimit(opts.limit);
    const ctx: Record<string, string> = {
      sort: opts.sort,
      category: opts.category ?? '',
      lifecycleStatus: opts.lifecycleStatus ?? '',
      q: opts.q ?? '',
      era: opts.era ?? '',
    };
    // Sort key mirrors the memory store: recently_* -> reviewedAt ?? publishedAt,
    // otherwise publishedAt. createdAt is NOT NULL so coalesce never yields NULL.
    const sortKey =
      opts.sort === 'recently_updated' || opts.sort === 'recently_verified'
        ? sql`coalesce(${dossierVersions.reviewedAt}, ${dossierVersions.publishedAt}, ${dossierVersions.createdAt})`
        : sql`coalesce(${dossierVersions.publishedAt}, ${dossierVersions.createdAt})`;

    const conditions = [
      eq(subjects.visibility, 'public'),
      eq(dossierVersions.publicationState, 'published'),
    ];
    if (opts.category) {
      conditions.push(eq(subjects.kind, fromCategory(opts.category)));
    }
    if (opts.lifecycleStatus) {
      const values = lifecycleFilterValues(opts.lifecycleStatus);
      if (values !== null) {
        if (values.length === 0) return { items: [], nextCursor: null };
        conditions.push(inArray(dossierVersions.lifecycleStatus, values));
      }
    }
    if (opts.q) {
      const pattern = `%${escapeLike(opts.q)}%`;
      conditions.push(
        or(ilike(subjects.slug, pattern), ilike(subjects.canonicalName, pattern))!,
      );
    }
    if (opts.cursor) {
      const parsed = decodeCursor(opts.cursor, ctx);
      if (!parsed || !validCursorDate(parsed.sortKey)) throw invalidCursor();
      conditions.push(sql`(${sortKey} < ${parsed.sortKey}::timestamptz OR (${sortKey} = ${parsed.sortKey}::timestamptz AND ${subjects.id} < ${parsed.id}::uuid))`);
    }

    const rows = await this.db
      .select({ subject: subjects, version: dossierVersions })
      .from(subjects)
      .innerJoin(dossierVersions, eq(dossierVersions.id, subjects.currentPublishedVersionId))
      .where(and(...conditions))
      .orderBy(sql`${sortKey} DESC`, desc(subjects.id))
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const counts = await this.sourceCounts(pageRows.map((r) => r.version.id));
    const items = pageRows.map((r) =>
      this.toSummary(r.subject, r.version, counts.get(r.version.id) ?? 0),
    );
    const nextCursor =
      rows.length > limit
        ? (() => {
            const last = pageRows[pageRows.length - 1];
            const v = last.version;
            const key =
              opts.sort === 'recently_updated' || opts.sort === 'recently_verified'
                ? (v.reviewedAt ?? v.publishedAt ?? v.createdAt)
                : (v.publishedAt ?? v.createdAt);
            return encodeCursor({ k: key.toISOString(), id: last.subject.id, ctx });
          })()
        : null;
    return { items, nextCursor };
  }

  async getDossier(slug: string): Promise<DossierDetail | null> {
    const found = await this.subjectWithVersion(slug);
    if (!found) return null;
    return this.toDetail(found.subject, found.version);
  }

  async listVersions(
    slug: string,
    page: PageInput,
  ): Promise<{ items: VersionSummary[]; nextCursor: string | null } | null> {
    const subj = await this.db
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.slug, slug), eq(subjects.visibility, 'public')))
      .limit(1);
    if (!subj[0]) return null;
    const rows = await this.db
      .select()
      .from(dossierVersions)
      .where(eq(dossierVersions.subjectId, subj[0].id))
      .orderBy(asc(dossierVersions.versionNumber));
    const items: VersionSummary[] = rows.map((v) => ({
      version: v.versionNumber,
      publishedAt: iso(v.publishedAt ?? v.createdAt) ?? new Date(0).toISOString(),
      changeCount: 0, // no per-version change tracking in schema; honest zero
      summary: v.statusReason,
      label:
        v.publicationKind === 'correction'
          ? 'correction'
          : v.publicationKind === 'retraction_notice'
            ? 'retraction'
            : 'published',
    }));
    const res = paginateRows(
      items,
      { limit: page.limit, cursor: page.cursor },
      { slug },
      (r) => String(r.version),
      (r) => String(r.version).padStart(10, '0'),
    );
    return res;
  }

  async getVersion(slug: string, version: number): Promise<DossierDetail | null> {
    const subj = await this.db
      .select()
      .from(subjects)
      .where(and(eq(subjects.slug, slug), eq(subjects.visibility, 'public')))
      .limit(1);
    if (!subj[0]) return null;
    const vRows = await this.db
      .select()
      .from(dossierVersions)
      .where(
        and(
          eq(dossierVersions.subjectId, subj[0].id),
          eq(dossierVersions.versionNumber, version),
        ),
      )
      .limit(1);
    if (!vRows[0]) return null;
    return this.toDetail(subj[0], vRows[0]);
  }

  async getCanonical(
    slug: string,
    version: number,
  ): Promise<{ bytes: Buffer; sha256: string } | null> {
    const subj = await this.db
      .select()
      .from(subjects)
      .where(and(eq(subjects.slug, slug), eq(subjects.visibility, 'public')))
      .limit(1);
    if (!subj[0]) return null;
    const vRows = await this.db
      .select()
      .from(dossierVersions)
      .where(
        and(
          eq(dossierVersions.subjectId, subj[0].id),
          eq(dossierVersions.versionNumber, version),
        ),
      )
      .limit(1);
    const v = vRows[0];
    if (!v || !this.storage) return null; // canonical bytes live in object storage
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.get('public', v.canonicalObjectKey);
    } catch {
      return null;
    }
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== v.publicPayloadHash) {
      // Integrity failure: never serve bytes that don't match the commitment.
      throw new Error('canonical digest mismatch for ' + v.canonicalObjectKey);
    }
    return { bytes: Buffer.from(bytes), sha256: v.publicPayloadHash };
  }

  async listTimeline(
    slug: string,
    page: PageInput,
  ): Promise<{ items: TimelineEvent[]; nextCursor: string | null } | null> {
    const found = await this.subjectWithVersion(slug);
    if (!found) return null;
    const rows = await this.db
      .select()
      .from(timelineEvents)
      .where(
        and(
          eq(timelineEvents.subjectId, found.subject.id),
          eq(timelineEvents.containerKind, 'version'),
          eq(timelineEvents.containerId, found.version.id),
        ),
      )
      .orderBy(asc(timelineEvents.displayOrder), asc(timelineEvents.id));
    const items: TimelineEvent[] = rows.map((t) => ({
      id: t.id,
      occurredAt: t.dateStart ?? '',
      datePrecision: toDatePrecision(t.datePrecision),
      title: t.title,
      type: t.eventType,
      description: t.summary ?? '',
      sources: [...t.sourceClaimIds],
    }));
    return paginateRows(
      items,
      { limit: page.limit, cursor: page.cursor },
      { slug },
      (r) => r.id,
      (r) => r.occurredAt,
    );
  }

  async listSources(
    slug: string,
    page: PageInput,
  ): Promise<{ items: SourceRecord[]; nextCursor: string | null } | null> {
    const found = await this.subjectWithVersion(slug);
    if (!found) return null;
    const linkRows = await this.db
      .selectDistinct({ sourceId: sources.id })
      .from(sources)
      .innerJoin(sourceSnapshots, eq(sourceSnapshots.sourceId, sources.id))
      .innerJoin(claimEvidence, eq(claimEvidence.sourceSnapshotId, sourceSnapshots.id))
      .innerJoin(claims, eq(claims.id, claimEvidence.claimId))
      .where(
        and(
          eq(claims.containerKind, 'version'),
          eq(claims.containerId, found.version.id),
        ),
      );
    const ids = [...new Set(linkRows.map((r) => r.sourceId))];
    if (ids.length === 0) return { items: [], nextCursor: null };
    const [srcRows, snapRows] = await Promise.all([
      this.db.select().from(sources).where(inArray(sources.id, ids)),
      this.db
        .select()
        .from(sourceSnapshots)
        .where(inArray(sourceSnapshots.sourceId, ids))
        .orderBy(desc(sourceSnapshots.fetchedAt)),
    ]);
    const latestSnap = new Map<string, (typeof snapRows)[number]>();
    for (const s of snapRows) {
      if (!latestSnap.has(s.sourceId)) latestSnap.set(s.sourceId, s);
    }
    const items: SourceRecord[] = srcRows
      .map((s) => {
        const snap = latestSnap.get(s.id) ?? null;
        return {
          id: s.id,
          url: s.canonicalUrl,
          title: s.publisher ?? s.domain ?? s.canonicalUrl,
          addedAt: s.firstSeenAt.toISOString(),
          archived: snap !== null,
          excerpt: snap?.publicExcerpt ?? null,
        };
      })
      .sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0));
    return paginateRows(
      items,
      { limit: page.limit, cursor: page.cursor },
      { slug },
      (r) => r.id,
      (r) => r.addedAt,
    );
  }

  async listMetrics(
    slug: string,
    page: PageInput,
  ): Promise<{ items: MetricObservation[]; nextCursor: string | null } | null> {
    const found = await this.subjectWithVersion(slug);
    if (!found) return null;
    const rows = await this.db
      .select()
      .from(observations)
      .where(eq(observations.subjectId, found.subject.id))
      .orderBy(asc(observations.observedAt), asc(observations.id));
    const items: MetricObservation[] = [];
    for (const o of rows) {
      // Unknown values are NULL in the schema but the public shape needs a
      // string; rows without a value are omitted rather than zero-filled.
      if (o.value === null) continue;
      items.push({
        id: o.id,
        metricKey: o.metricName,
        value: o.value,
        unit: o.unit ?? '',
        observedAt: o.observedAt.toISOString(),
        source: o.provider ?? o.collectionMethod ?? '',
        coverageStart: null, // measurementWindow is an interval literal; not split
        coverageEnd: null,
      });
    }
    return paginateRows(
      items,
      { limit: page.limit, cursor: page.cursor },
      { slug },
      (r) => r.id,
      (r) => r.observedAt,
    );
  }

  async listRelations(
    slug: string,
    page: PageInput,
  ): Promise<{ items: RelationEdge[]; nextCursor: string | null } | null> {
    const found = await this.subjectWithVersion(slug);
    if (!found) return null;
    const rows = await this.db
      .select({ rel: subjectRelations, target: subjects })
      .from(subjectRelations)
      .innerJoin(subjects, eq(subjects.id, subjectRelations.toSubjectId))
      .where(eq(subjectRelations.fromSubjectId, found.subject.id))
      .orderBy(asc(subjects.slug), asc(subjectRelations.id));
    const items: RelationEdge[] = rows.map((r) => ({
      id: r.rel.id,
      targetSlug: r.target.slug,
      targetName: r.target.canonicalName,
      relationshipType: r.rel.relationshipType,
      strength: confidenceToStrength(r.rel.confidence),
      reason: '', // schema stores evidence via supporting_claim_id, not prose
      claimIds: r.rel.supportingClaimId ? [r.rel.supportingClaimId] : [],
    }));
    return paginateRows(
      items,
      { limit: page.limit, cursor: page.cursor },
      { slug },
      (r) => r.id,
      (r) => r.targetSlug,
    );
  }

  private async changesForSubject(subjectId: string): Promise<ChangeEntry[]> {
    const [corRows, retRows] = await Promise.all([
      this.db
        .select({ correction: corrections, version: dossierVersions })
        .from(corrections)
        .innerJoin(dossierVersions, eq(dossierVersions.id, corrections.versionId))
        .where(eq(corrections.subjectId, subjectId)),
      this.db
        .select()
        .from(dossierVersions)
        .where(
          and(
            eq(dossierVersions.subjectId, subjectId),
            eq(dossierVersions.publicationState, 'retracted'),
          ),
        ),
    ]);
    const entries: ChangeEntry[] = corRows.map((r) => ({
      id: r.correction.id,
      version: r.version.versionNumber,
      changedAt: r.correction.createdAt.toISOString(),
      changeType: 'correction' as const,
      explanation: r.correction.correctionText,
      diff: [], // per-field diffs are not tracked in the schema
    }));
    for (const v of retRows) {
      entries.push({
        id: `retraction-${v.id}`,
        version: v.versionNumber,
        changedAt: (v.publishedAt ?? v.createdAt).toISOString(),
        changeType: 'retraction' as const,
        explanation: v.statusReason,
        diff: [],
      });
    }
    entries.sort((a, b) => (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : 0));
    return entries;
  }

  private async recentChanges(limit: number): Promise<ChangeEntry[]> {
    const [corRows, retRows] = await Promise.all([
      this.db
        .select({ correction: corrections, version: dossierVersions })
        .from(corrections)
        .innerJoin(dossierVersions, eq(dossierVersions.id, corrections.versionId))
        .orderBy(desc(corrections.createdAt))
        .limit(limit),
      this.db
        .select()
        .from(dossierVersions)
        .where(eq(dossierVersions.publicationState, 'retracted'))
        .orderBy(desc(dossierVersions.publishedAt))
        .limit(limit),
    ]);
    const entries: ChangeEntry[] = corRows.map((r) => ({
      id: r.correction.id,
      version: r.version.versionNumber,
      changedAt: r.correction.createdAt.toISOString(),
      changeType: 'correction' as const,
      explanation: r.correction.correctionText,
      diff: [],
    }));
    for (const v of retRows) {
      entries.push({
        id: `retraction-${v.id}`,
        version: v.versionNumber,
        changedAt: (v.publishedAt ?? v.createdAt).toISOString(),
        changeType: 'retraction' as const,
        explanation: v.statusReason,
        diff: [],
      });
    }
    entries.sort((a, b) => (a.changedAt > b.changedAt ? -1 : a.changedAt < b.changedAt ? 1 : 0));
    return entries.slice(0, limit);
  }

  async listChanges(
    slug: string,
    page: PageInput,
  ): Promise<{ items: ChangeEntry[]; nextCursor: string | null } | null> {
    const subj = await this.db
      .select({ id: subjects.id })
      .from(subjects)
      .where(and(eq(subjects.slug, slug), eq(subjects.visibility, 'public')))
      .limit(1);
    if (!subj[0]) return null;
    const items = await this.changesForSubject(subj[0].id);
    return paginateRows(
      items,
      { limit: page.limit, cursor: page.cursor },
      { slug },
      (r) => r.id,
      (r) => r.changedAt,
    );
  }

  /* ---------------- collections, search, activity, receipts ---------------- */

  async getCollection(_slug: string): Promise<CollectionDetail | null> {
    // Schema gap: there is no editorial-collections table (homeEditions /
    // featuredItems model dated home editions, not named collections like
    // 'still-alive'). Returning null (404) instead of inventing a collection.
    return null;
  }

  async suggest(q: string, limit: number): Promise<SuggestItem[]> {
    const pattern = `%${escapeLike(q)}%`;
    const rows = await this.db
      .select({ slug: subjects.slug, name: subjects.canonicalName, kind: subjects.kind })
      .from(subjects)
      .where(
        and(
          eq(subjects.visibility, 'public'),
          or(ilike(subjects.slug, pattern), ilike(subjects.canonicalName, pattern))!,
        ),
      )
      .orderBy(asc(subjects.slug))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows.map((r) => ({ slug: r.slug, name: r.name, category: toCategory(r.kind) }));
  }

  async listActivity(
    page: PageInput,
    eventType?: PublicEventType,
  ): Promise<{ items: ActivityEvent[]; nextCursor: string | null }> {
    const limit = normalizeLimit(page.limit);
    const ctx: Record<string, string> = { eventType: eventType ?? '' };
    const conditions = [eq(activityEvents.visibility, 'public')];
    if (eventType) conditions.push(eq(activityEvents.eventType, eventType));
    if (page.cursor) {
      const parsed = decodeCursor(page.cursor, ctx);
      const seq = Number(parsed?.sortKey);
      if (!parsed || !Number.isInteger(seq)) throw invalidCursor();
      conditions.push(
        sql`(${activityEvents.sequence} < ${seq} OR (${activityEvents.sequence} = ${seq} AND ${activityEvents.id} < ${parsed.id}::uuid))`,
      );
    }
    const rows = await this.db
      .select()
      .from(activityEvents)
      .where(and(...conditions))
      .orderBy(desc(activityEvents.sequence), desc(activityEvents.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const items: ActivityEvent[] = pageRows.map((e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const dv = payload['dossierVersion'];
      return {
        eventId: e.id,
        sequenceId: String(e.sequence),
        eventType: e.eventType as PublicEventType,
        occurredAt: e.occurredAt.toISOString(),
        subjectId: e.aggregateId,
        dossierVersion: typeof dv === 'number' ? dv : null,
        aggregateRevision: e.aggregateRevision,
        payload,
      };
    });
    const nextCursor =
      rows.length > limit
        ? (() => {
            const last = pageRows[pageRows.length - 1];
            return encodeCursor({ k: String(last.sequence), id: last.id, ctx });
          })()
        : null;
    return { items, nextCursor };
  }

  async getReceipt(id: string): Promise<ReceiptDetail | null> {
    const rows = await this.db
      .select({ receipt: publicationReceipts, version: dossierVersions, subject: subjects })
      .from(publicationReceipts)
      .innerJoin(dossierVersions, eq(dossierVersions.id, publicationReceipts.versionId))
      .innerJoin(subjects, eq(subjects.id, dossierVersions.subjectId))
      .where(eq(publicationReceipts.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const { receipt, version, subject } = row;
    const finalized = receipt.status === 'finalized';
    return {
      id: receipt.id,
      dossierSlug: subject.slug,
      version: version.versionNumber,
      status: finalized ? 'finalized' : receipt.status === 'failed' ? 'failed' : 'pending',
      signature: receipt.signature,
      transactionId: receipt.signature,
      payloadHash: version.publicPayloadHash,
      createdAt: receipt.createdAt.toISOString(),
      finalizedAt: finalized ? (receipt.blockTime?.toISOString() ?? null) : null,
      canonicalBundleUrl: this.storage
        ? this.storage.publicUrl(version.canonicalObjectKey)
        : null,
    };
  }

  async getMethodology(): Promise<MethodologyPayload> {
    // Editorial static content (same as the memory store); not per-row data.
    return {
      version: '1.0.0',
      updatedAt: '2026-10-16T00:00:00Z',
      sections: [
        {
          id: 'evidence',
          heading: 'Evidence standards',
          body: 'Every factual claim links to a public evidence record.',
        },
        {
          id: 'review',
          heading: 'Editorial review',
          body: 'Two-reviewer sign-off before publication.',
        },
      ],
    };
  }

  async getStatus(): Promise<StatusPayload> {
    let dbComponent: StatusPayload['components'][number];
    try {
      await this.db.execute(sql`SELECT 1`);
      dbComponent = { name: 'database', status: 'operational', detail: 'Postgres connected' };
    } catch (err) {
      dbComponent = {
        name: 'database',
        status: 'down',
        detail: `Postgres unreachable: ${(err as Error).message}`,
      };
    }
    const components: StatusPayload['components'] = [
      { name: 'api', status: 'operational', detail: 'Serving requests' },
      dbComponent,
      { name: 'read-models', status: 'operational', detail: 'Postgres store' },
    ];
    return {
      status: components.some((c) => c.status === 'down') ? 'degraded' : 'operational',
      asOf: new Date().toISOString(),
      components,
    };
  }

  async getShare(slug: string, version: number): Promise<SharePayload | null> {
    const subj = await this.db
      .select()
      .from(subjects)
      .where(and(eq(subjects.slug, slug), eq(subjects.visibility, 'public')))
      .limit(1);
    if (!subj[0]) return null;
    const vRows = await this.db
      .select({ versionNumber: dossierVersions.versionNumber })
      .from(dossierVersions)
      .where(
        and(
          eq(dossierVersions.subjectId, subj[0].id),
          eq(dossierVersions.versionNumber, version),
        ),
      )
      .limit(1);
    if (!vRows[0]) return null;
    return {
      slug,
      version,
      title: `${subj[0].canonicalName} — version ${version}`,
      imageUrl: null,
      metadata: { description: subj[0].shortDescription ?? '' },
    };
  }

  private async stillAliveSummaries(limit: number): Promise<DossierSummary[]> {
    const rows = await this.db
      .select({ subject: subjects, version: dossierVersions })
      .from(subjects)
      .innerJoin(dossierVersions, eq(dossierVersions.id, subjects.currentPublishedVersionId))
      .where(
        and(
          eq(subjects.visibility, 'public'),
          eq(dossierVersions.publicationState, 'published'),
          // Same 'active' bucket as listDossiers(lifecycleStatus='active'): revived counts.
          inArray(dossierVersions.lifecycleStatus, ['active', 'revived']),
        ),
      )
      .orderBy(desc(dossierVersions.publishedAt))
      .limit(limit);
    const counts = await this.sourceCounts(rows.map((r) => r.version.id));
    return rows.map((r) => this.toSummary(r.subject, r.version, counts.get(r.version.id) ?? 0));
  }

  /* ---------------- personal ---------------- */

  private roleToApi(role: string): MeProfile['roles'][number] {
    // DB roles: admin | editor | reviewer | viewer. API roles: reader |
    // contributor | editor | administrator.
    switch (role) {
      case 'admin':
        return 'administrator';
      case 'editor':
        return 'editor';
      case 'reviewer':
        return 'contributor';
      default:
        return 'reader';
    }
  }

  async getOrCreateProfile(userId: string, address: string): Promise<MeProfile> {
    let rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!rows[0]) {
      const ins = await this.db.insert(users).values({ id: userId }).returning();
      rows = ins;
    }
    const user = rows[0];
    // Idempotent wallet-link: one identity per chain+address (unique index).
    await this.db
      .insert(walletIdentities)
      .values({ userId: user.id, chain: 'solana', address })
      .onConflictDoNothing();
    const grants = await this.db
      .select({ role: roleGrants.role })
      .from(roleGrants)
      .where(
        and(eq(roleGrants.userId, user.id), sql`${roleGrants.revokedAt} IS NULL`),
      );
    const roles = grants.map((g) => this.roleToApi(g.role));
    return {
      userId: user.id,
      address,
      roles: roles.length > 0 ? [...new Set(roles)] : ['reader'],
      capabilities: [],
      createdAt: user.createdAt.toISOString(),
    };
  }

  async listBookmarks(userId: string): Promise<BookmarkRecord[]> {
    const rows = await this.db
      .select({ bookmark: bookmarks, subject: subjects })
      .from(bookmarks)
      .innerJoin(subjects, eq(subjects.id, bookmarks.subjectId))
      .where(eq(bookmarks.userId, userId))
      .orderBy(desc(bookmarks.createdAt));
    return rows.map((r) => ({
      subjectId: r.bookmark.subjectId,
      dossierSlug: r.subject.slug,
      createdAt: r.bookmark.createdAt.toISOString(),
    }));
  }

  async putBookmark(
    userId: string,
    subjectId: string,
    dossierSlug: string,
  ): Promise<BookmarkRecord> {
    await this.db
      .insert(bookmarks)
      .values({ userId, subjectId })
      .onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), eq(bookmarks.subjectId, subjectId)))
      .limit(1);
    const rec = rows[0];
    if (!rec) throw new Error('bookmark insert failed');
    return {
      subjectId: rec.subjectId,
      dossierSlug,
      createdAt: rec.createdAt.toISOString(),
    };
  }

  async deleteBookmark(userId: string, subjectId: string): Promise<boolean> {
    const del = await this.db
      .delete(bookmarks)
      .where(and(eq(bookmarks.userId, userId), eq(bookmarks.subjectId, subjectId)))
      .returning({ id: bookmarks.id });
    return del.length > 0;
  }

  /** The schema models named watchlists; the API exposes one default list. */
  private async defaultWatchlistId(userId: string): Promise<string> {
    const existing = await this.db
      .select({ id: watchlists.id })
      .from(watchlists)
      .where(and(eq(watchlists.userId, userId), eq(watchlists.name, 'default')))
      .limit(1);
    if (existing[0]) return existing[0].id;
    const ins = await this.db
      .insert(watchlists)
      .values({ userId, name: 'default' })
      .onConflictDoNothing()
      .returning({ id: watchlists.id });
    if (ins[0]) return ins[0].id;
    const retry = await this.db
      .select({ id: watchlists.id })
      .from(watchlists)
      .where(and(eq(watchlists.userId, userId), eq(watchlists.name, 'default')))
      .limit(1);
    if (!retry[0]) throw new Error('watchlist creation failed');
    return retry[0].id;
  }

  async listWatchlist(userId: string): Promise<WatchlistRecord[]> {
    const wlId = await this.defaultWatchlistId(userId);
    const rows = await this.db
      .select({ item: watchlistItems, subject: subjects })
      .from(watchlistItems)
      .innerJoin(subjects, eq(subjects.id, watchlistItems.subjectId))
      .where(eq(watchlistItems.watchlistId, wlId))
      .orderBy(desc(watchlistItems.addedAt));
    return rows.map((r) => ({
      subjectId: r.item.subjectId,
      dossierSlug: r.subject.slug,
      createdAt: r.item.addedAt.toISOString(),
    }));
  }

  async putWatchlist(
    userId: string,
    subjectId: string,
    dossierSlug: string,
  ): Promise<WatchlistRecord> {
    const wlId = await this.defaultWatchlistId(userId);
    await this.db
      .insert(watchlistItems)
      .values({ watchlistId: wlId, subjectId })
      .onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(watchlistItems)
      .where(
        and(
          eq(watchlistItems.watchlistId, wlId),
          eq(watchlistItems.subjectId, subjectId),
        ),
      )
      .limit(1);
    const rec = rows[0];
    if (!rec) throw new Error('watchlist insert failed');
    return {
      subjectId: rec.subjectId,
      dossierSlug,
      createdAt: rec.addedAt.toISOString(),
    };
  }

  async deleteWatchlist(userId: string, subjectId: string): Promise<boolean> {
    const wlId = await this.defaultWatchlistId(userId);
    const del = await this.db
      .delete(watchlistItems)
      .where(
        and(
          eq(watchlistItems.watchlistId, wlId),
          eq(watchlistItems.subjectId, subjectId),
        ),
      )
      .returning({ id: watchlistItems.id });
    return del.length > 0;
  }

  async listNotifications(userId: string): Promise<NotificationRecord[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt));
    return rows.map((n) => ({
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      body: n.body ?? '',
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    }));
  }

  async markNotificationRead(
    userId: string,
    id: string,
  ): Promise<NotificationRecord | null> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning();
    const n = updated[0];
    if (!n) return null;
    return {
      id: n.id,
      userId: n.userId,
      type: n.type,
      title: n.title,
      body: n.body ?? '',
      read: true,
      createdAt: n.createdAt.toISOString(),
    };
  }

  async createSubmission(
    userId: string,
    input: { subjectName: string; candidateUrls: string[]; reason: string },
  ): Promise<SubmissionTicket> {
    // subjectName may be a slug or a display name; link when identifiable.
    const subj = await this.db
      .select({ id: subjects.id })
      .from(subjects)
      .where(
        or(
          eq(subjects.slug, input.subjectName),
          ilike(subjects.canonicalName, input.subjectName),
        )!,
      )
      .limit(1);
    const ins = await this.db
      .insert(submissions)
      .values({
        submitterId: userId,
        subjectId: subj[0]?.id ?? null,
        suppliedEvidenceUrls: input.candidateUrls,
        reason: input.reason,
      })
      .returning();
    const s = ins[0];
    return {
      id: s.id,
      userId,
      subjectName: input.subjectName,
      candidateUrls: [...s.suppliedEvidenceUrls],
      reason: s.reason,
      status: toTicketStatus(s.moderationState),
      createdAt: s.createdAt.toISOString(),
    };
  }

  async createCorrection(
    userId: string,
    dossierSlug: string,
    input: { claimedIssue: string; evidenceUrls: string[]; explanatoryText: string },
  ): Promise<CorrectionTicket> {
    const found = await this.subjectWithVersion(dossierSlug);
    if (!found) throw new Error(`no published version for dossier: ${dossierSlug}`);
    // Schema gap: corrections has no evidence_urls column. Evidence URLs are
    // appended to the stored text under a clear label (the API response keeps
    // the fields separate); never silently dropped.
    const parts = [input.claimedIssue];
    if (input.evidenceUrls.length > 0) {
      parts.push(`Evidence:\n${input.evidenceUrls.join('\n')}`);
    }
    if (input.explanatoryText) parts.push(input.explanatoryText);
    const ins = await this.db
      .insert(corrections)
      .values({
        versionId: found.version.id,
        subjectId: found.subject.id,
        submittedBy: userId,
        correctionText: parts.join('\n\n'),
      })
      .returning();
    const c = ins[0];
    return {
      id: c.id,
      userId,
      dossierSlug,
      claimedIssue: input.claimedIssue,
      evidenceUrls: input.evidenceUrls,
      explanatoryText: input.explanatoryText,
      status: toTicketStatus(c.moderationState),
      createdAt: c.createdAt.toISOString(),
    };
  }

  async listMySubmissions(userId: string): Promise<SubmissionTicket[]> {
    const rows = await this.db
      .select({ submission: submissions, subject: subjects })
      .from(submissions)
      .leftJoin(subjects, eq(subjects.id, submissions.subjectId))
      .where(eq(submissions.submitterId, userId))
      .orderBy(desc(submissions.createdAt));
    return rows.map((r) => ({
      id: r.submission.id,
      userId,
      subjectName: r.subject?.canonicalName ?? '',
      candidateUrls: [...r.submission.suppliedEvidenceUrls],
      reason: r.submission.reason,
      status: toTicketStatus(r.submission.moderationState),
      createdAt: r.submission.createdAt.toISOString(),
    }));
  }

  async listMyOrders(_userId: string): Promise<unknown[]> {
    // Payments are disabled (PAYMENTS_ENABLED=false); no orders exist.
    return [];
  }
}
