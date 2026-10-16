/**
 * PostgresStore contract tests (live Postgres).
 *
 * Skipped gracefully when DATABASE_URL is unset — the rest of the suite
 * must pass without a database (MemoryStore fallback). When DATABASE_URL is
 * set, migrations are applied first: point it at a SCRATCH database, never
 * production.
 *
 * Covers the ReadStore contract against real Postgres: dossier reads,
 * pagination cursors, mappings (category/lifecycle/proof), personal
 * records (bookmarks/watchlist/notifications), and tickets. Sessions and
 * challenges are NOT covered here — they remain in-memory stores by design
 * (Redis in production) and are tested in auth.service.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@afterbyte/database';
import * as s from '@afterbyte/database';
import { PostgresStore } from '../src/services/postgres-store.js';
import type { ConfigPayload } from '../src/services/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const TEST_CONFIG: ConfigPayload = {
  brand: { name: 'AFTERBYTE', tagline: 'The internet moves on. We follow up.' },
  canonicalUrls: { site: '', api: '' },
  features: { paymentsEnabled: false, tokenEnabled: false, researchEnabled: false },
  chain: 'solana:devnet',
  programId: null,
  acceptedPaymentAssets: [],
  providerStatus: {
    search: 'unavailable',
    models: 'unavailable',
    receipts: 'unavailable',
    storage: 'unavailable',
  },
};

describeDb('PostgresStore (live)', () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let store: PostgresStore;
  const suffix = randomUUID().slice(0, 8);
  const slugA = `pg-test-a-${suffix}`;
  const slugB = `pg-test-b-${suffix}`;
  let subjectAId = '';
  let versionAId = '';
  const userId = randomUUID();

  beforeAll(async () => {
    await runMigrations();
    const created = createDb(DATABASE_URL!);
    db = created.db;
    pool = created.pool;
    store = new PostgresStore(db, { config: TEST_CONFIG, storage: null });

    // Subject A: full dossier (published, active, with draft/sections,
    // timeline, observation, relation, correction).
    const [subA] = await db
      .insert(s.subjects)
      .values({
        slug: slugA,
        canonicalName: `PG Test A ${suffix}`,
        kind: 'crypto_project',
        shortDescription: 'A test subject',
      })
      .returning({ id: s.subjects.id });
    subjectAId = subA.id;
    const [verA] = await db
      .insert(s.dossierVersions)
      .values({
        subjectId: subjectAId,
        versionNumber: 1,
        publicationKind: 'initial',
        lifecycleStatus: 'revived',
        canonicalObjectKey: `dossiers/${slugA}/v1.json`,
        publicPayloadHash: '0'.repeat(64),
        previousPayloadHash: '0'.repeat(64), // v1 genesis: zero hash
        publishedAt: new Date('2026-01-01T00:00:00Z'),
        reviewedAt: new Date('2026-02-01T00:00:00Z'),
        statusReason: 'Revived after dormancy.',
        confidenceBand: 'moderate',
        confidenceReason: 'Two independent sources.',
      })
      .returning({ id: s.dossierVersions.id, versionNumber: s.dossierVersions.versionNumber });
    versionAId = verA.id;
    await db
      .update(s.subjects)
      .set({ currentPublishedVersionId: versionAId })
      .where(eq(s.subjects.id, subjectAId));
    await db.insert(s.dossierDrafts).values({
      subjectId: subjectAId,
      structuredContent: {
        sections: [{ id: 's1', heading: 'Overview', blocks: [{ type: 'p', text: 'Hello' }] }],
      },
    });
    await db.insert(s.timelineEvents).values({
      subjectId: subjectAId,
      containerKind: 'version',
      containerId: versionAId,
      eventType: 'launch',
      title: 'Launch',
      dateStart: '2025',
      datePrecision: 'year',
      displayOrder: 0,
      sourceClaimIds: [],
    });
    await db.insert(s.observations).values({
      subjectId: subjectAId,
      metricName: 'users',
      value: '1234',
      unit: 'count',
      observedAt: new Date('2026-01-15T00:00:00Z'),
    });
    const [subB] = await db
      .insert(s.subjects)
      .values({ slug: slugB, canonicalName: `PG Test B ${suffix}`, kind: 'app' })
      .returning({ id: s.subjects.id });
    const [verB] = await db
      .insert(s.dossierVersions)
      .values({
        subjectId: subB.id,
        versionNumber: 1,
        publicationKind: 'initial',
        lifecycleStatus: 'active',
        statusReason: 'Test fixture.',
        canonicalObjectKey: `dossiers/${slugB}/v1.json`,
        publicPayloadHash: '1'.repeat(64),
        previousPayloadHash: '0'.repeat(64), // v1 genesis: zero hash
        publishedAt: new Date('2026-03-01T00:00:00Z'),
      })
      .returning({ id: s.dossierVersions.id });
    await db
      .update(s.subjects)
      .set({ currentPublishedVersionId: verB.id })
      .where(eq(s.subjects.id, subB.id));
    await db.insert(s.subjectRelations).values({
      fromSubjectId: subjectAId,
      toSubjectId: subB.id,
      relationshipType: 'other',
      confidence: '0.8',
    });
  }, 60000);

  afterAll(async () => {
    try {
      await db.delete(s.subjectRelations).where(eq(s.subjectRelations.fromSubjectId, subjectAId));
      await db.delete(s.dossierVersions).where(eq(s.dossierVersions.subjectId, subjectAId));
      await db.delete(s.subjects).where(eq(s.subjects.id, subjectAId));
      const bRows = await db.select({ id: s.subjects.id }).from(s.subjects).where(eq(s.subjects.slug, slugB));
      for (const r of bRows) {
        await db.delete(s.dossierVersions).where(eq(s.dossierVersions.subjectId, r.id));
        await db.delete(s.subjects).where(eq(s.subjects.id, r.id));
      }
      await db.delete(s.users).where(eq(s.users.id, userId));
    } catch {
      // best-effort cleanup on a scratch DB
    }
    await pool.end();
  });

  it('reads a dossier with mapped values (category, lifecycle, sections)', async () => {
    const d = await store.getDossier(slugA);
    expect(d).not.toBeNull();
    expect(d!.slug).toBe(slugA);
    expect(d!.category).toBe('crypto'); // crypto_project -> crypto
    expect(d!.lifecycleStatus).toBe('active'); // revived -> active
    expect(d!.statusReason).toBe('Revived after dormancy.');
    expect(d!.sections).toHaveLength(1);
    expect(d!.sections[0].heading).toBe('Overview');
    expect(d!.timelinePreview).toHaveLength(1);
    expect(d!.timelinePreview[0].title).toBe('Launch');
    expect(d!.proof.status).toBe('pending'); // no receipt row yet
    expect(d!.proof.receiptId).toBeNull();
    expect(d!.availableMetrics).toContain('users');
    expect(d!.relationsPreview).toHaveLength(1);
    expect(d!.relationsPreview[0].relationshipType).toBe('other');
    expect(d!.evidenceAssessment).toEqual({ band: 'moderate', reason: 'Two independent sources.' });
  });

  it('returns null for unknown dossiers (404 semantics)', async () => {
    expect(await store.getDossier(`nope-${suffix}`)).toBeNull();
    expect(await store.getVersion(`nope-${suffix}`, 1)).toBeNull();
    expect(await store.listVersions(`nope-${suffix}`, { limit: 10 })).toBeNull();
    expect(await store.listTimeline(`nope-${suffix}`, { limit: 10 })).toBeNull();
  });

  it('lists dossiers with filters and cursor pagination', async () => {
    const page1 = await store.listDossiers({ sort: 'relevance', limit: 1, q: suffix });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first: B (2026-03-01) before A (2026-01-01)
    expect(page1.items[0].slug).toBe(slugB);
    const page2 = await store.listDossiers({
      sort: 'relevance',
      limit: 1,
      q: suffix,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].slug).toBe(slugA);
    expect(page2.nextCursor).toBeNull();

    const crypto = await store.listDossiers({ sort: 'relevance', limit: 10, q: suffix, category: 'crypto' });
    expect(crypto.items.map((i) => i.slug)).toEqual([slugA]);
    const active = await store.listDossiers({ sort: 'relevance', limit: 10, q: suffix, lifecycleStatus: 'active' });
    expect(active.items.map((i) => i.slug).sort()).toEqual([slugA, slugB].sort());
    const declining = await store.listDossiers({ sort: 'relevance', limit: 10, q: suffix, lifecycleStatus: 'declining' });
    expect(declining.items).toEqual([]);
  });

  it('rejects a tampered cursor', async () => {
    await expect(
      store.listDossiers({ sort: 'relevance', limit: 10, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lists versions and reads a specific version', async () => {
    const versions = await store.listVersions(slugA, { limit: 10 });
    expect(versions).not.toBeNull();
    expect(versions!.items).toHaveLength(1);
    expect(versions!.items[0].label).toBe('published');
    const v1 = await store.getVersion(slugA, 1);
    expect(v1?.version).toBe(1);
    expect(await store.getVersion(slugA, 999)).toBeNull();
  });

  it('reads timeline, metrics, relations', async () => {
    const timeline = await store.listTimeline(slugA, { limit: 10 });
    expect(timeline!.items[0]).toMatchObject({ title: 'Launch', datePrecision: 'year' });
    const metrics = await store.listMetrics(slugA, { limit: 10 });
    expect(metrics!.items[0]).toMatchObject({ metricKey: 'users', value: '1234' });
    const relations = await store.listRelations(slugA, { limit: 10 });
    expect(relations!.items[0]).toMatchObject({ targetSlug: slugB, strength: 'strong', relationshipType: 'other' });
    const sources = await store.listSources(slugA, { limit: 10 });
    expect(sources!.items).toEqual([]);
  });

  it('suggests by name prefix', async () => {
    const items = await store.suggest(`PG Test A ${suffix}`, 10);
    expect(items.some((i) => i.slug === slugA)).toBe(true);
  });

  it('creates a profile idempotently', async () => {
    const p1 = await store.getOrCreateProfile(userId, 'TestWallet1111111111111111111111111111111');
    expect(p1.userId).toBe(userId);
    expect(p1.roles).toEqual(['reader']);
    const p2 = await store.getOrCreateProfile(userId, 'TestWallet1111111111111111111111111111111');
    expect(p2.userId).toBe(userId);
  });

  it('round-trips bookmarks', async () => {
    const put = await store.putBookmark(userId, subjectAId, slugA);
    expect(put.dossierSlug).toBe(slugA);
    const list = await store.listBookmarks(userId);
    expect(list.some((b) => b.subjectId === subjectAId)).toBe(true);
    expect(await store.deleteBookmark(userId, subjectAId)).toBe(true);
    expect(await store.deleteBookmark(userId, subjectAId)).toBe(false);
  });

  it('round-trips watchlist', async () => {
    await store.putWatchlist(userId, subjectAId, slugA);
    const list = await store.listWatchlist(userId);
    expect(list.some((w) => w.subjectId === subjectAId)).toBe(true);
    expect(await store.deleteWatchlist(userId, subjectAId)).toBe(true);
    expect(await store.deleteWatchlist(userId, subjectAId)).toBe(false);
  });

  it('lists and marks notifications', async () => {
    const [n] = await db
      .insert(s.notifications)
      .values({ userId, type: 'watchlist', title: 'Hello' })
      .returning({ id: s.notifications.id });
    const list = await store.listNotifications(userId);
    const found = list.find((x) => x.id === n.id);
    expect(found?.read).toBe(false);
    const marked = await store.markNotificationRead(userId, n.id);
    expect(marked?.read).toBe(true);
    expect(await store.markNotificationRead(userId, randomUUID())).toBeNull();
  });

  it('creates and lists tickets', async () => {
    const sub = await store.createSubmission(userId, {
      subjectName: slugA,
      candidateUrls: ['https://example.com/x'],
      reason: 'Worth tracking',
    });
    expect(sub.status).toBe('open');
    const mine = await store.listMySubmissions(userId);
    expect(mine.some((t) => t.id === sub.id)).toBe(true);

    const cor = await store.createCorrection(userId, slugA, {
      claimedIssue: 'Date is wrong',
      evidenceUrls: ['https://example.com/proof'],
      explanatoryText: 'See link.',
    });
    expect(cor.status).toBe('open');
    const changes = await store.listChanges(slugA, { limit: 10 });
    expect(changes!.items.some((c) => c.id === cor.id)).toBe(true);
  });

  it('reports stats, status, home, share', async () => {
    const stats = await store.getStats();
    expect(stats.archiveCount).toBeGreaterThanOrEqual(2);
    expect(stats.activeCount).toBeGreaterThanOrEqual(2); // revived counts as active
    const status = await store.getStatus();
    expect(status.status).toBe('operational');
    expect(status.components.some((c) => c.name === 'database' && c.status === 'operational')).toBe(true);
    const home = await store.getHome();
    expect(home.stats.archiveCount).toBeGreaterThanOrEqual(2);
    const share = await store.getShare(slugA, 1);
    expect(share?.slug).toBe(slugA);
    expect(await store.getShare(slugA, 999)).toBeNull();
    expect(await store.getCollection('still-alive')).toBeNull();
    const canonical = await store.getCanonical(slugA, 1);
    expect(canonical).toBeNull(); // storage unconfigured -> honest null
    expect(await store.listMyOrders(userId)).toEqual([]);
  });

  it('lists activity events', async () => {
    await db.insert(s.activityEvents).values({
      eventType: 'dossier.published',
      aggregateId: subjectAId,
      aggregateRevision: 1,
      payload: { dossierVersion: 1 },
      visibility: 'public',
      occurredAt: new Date('2026-04-01T00:00:00Z'),
    });
    const page = await store.listActivity({ limit: 10 });
    const found = page.items.find((e) => e.subjectId === subjectAId);
    expect(found).toBeDefined();
    expect(found!.dossierVersion).toBe(1);
    expect(found!.sequenceId).toBeDefined();
  });
});
