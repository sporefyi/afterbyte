/**
 * Read models (brief §14): built from published data ONLY. Aggregate counts
 * exclude rejected/unpublished; "recorded" = versions with finalized receipts.
 * asOf + source revision are stored with every materialization.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildHomeReadModel,
  buildCollectionReadModel,
  buildStatsReadModel,
  refreshAllReadModels,
} from '../src/readmodels.js';
import { MemReadModelStore } from '../src/fakes.js';
import { createLogger } from '../src/logging.js';
import type { PublishedSubjectRow } from '../src/types.js';

const rows: PublishedSubjectRow[] = [
  { subjectId: 's-active', lifecycleStatus: 'active', isRetracted: false, currentVersionNumber: 3, versionsWithFinalizedReceipts: 3 },
  { subjectId: 's-dormant', lifecycleStatus: 'dormant', isRetracted: false, currentVersionNumber: 1, versionsWithFinalizedReceipts: 0 },
  { subjectId: 's-retracted', lifecycleStatus: 'active', isRetracted: true, currentVersionNumber: 2, versionsWithFinalizedReceipts: 1 },
  { subjectId: 's-unpublished', lifecycleStatus: 'active', isRetracted: false, currentVersionNumber: null, versionsWithFinalizedReceipts: 0 },
];

describe('buildHomeReadModel', () => {
  it('excludes retracted and unpublished subjects from the archive count', () => {
    const m = buildHomeReadModel(rows);
    // s-active + s-dormant only.
    expect(m.archiveCount).toBe(2);
  });

  it('counts only active, published, non-retracted subjects', () => {
    const m = buildHomeReadModel(rows);
    expect(m.activeCount).toBe(1);
  });

  it('recorded = versions with finalized receipts (published, non-retracted only)', () => {
    const m = buildHomeReadModel(rows);
    // s-active has 3; s-dormant 0; retracted + unpublished rows are excluded.
    expect(m.recordedCount).toBe(3);
  });
});

describe('buildCollectionReadModel', () => {
  it('counts published non-retracted subjects by lifecycle status', () => {
    const m = buildCollectionReadModel(rows);
    expect(m.subjectCount).toBe(2);
    expect(m.byStatus).toEqual({ active: 1, dormant: 1 });
  });
});

describe('buildStatsReadModel', () => {
  it('sums versions and finalized receipts over published rows', () => {
    const m = buildStatsReadModel(rows);
    // s-active v3 + s-dormant v1; retracted + unpublished rows excluded.
    expect(m.totalVersions).toBe(4);
    expect(m.totalFinalizedReceipts).toBe(3);
  });
});

describe('refreshAllReadModels', () => {
  let store: MemReadModelStore;
  beforeEach(() => {
    store = new MemReadModelStore();
    store.subjects = [...rows];
    store.sourceRevision = 'rev-123';
  });

  it('materializes all scopes with asOf + source revision', async () => {
    const logger = createLogger({ test: 'readmodels' });
    const result = await refreshAllReadModels(store, logger, 'all', () => '2026-10-16T10:00:00Z');
    expect(result.refreshed.sort()).toEqual(['collection', 'home', 'stats']);
    expect(result.sourceRevision).toBe('rev-123');
    for (const key of ['home', 'collection', 'stats']) {
      const model = await store.transaction((tx) => store.getReadModel(tx, key));
      expect(model).not.toBeNull();
      expect(model?.asOf).toBe('2026-10-16T10:00:00Z');
      expect(model?.sourceRevision).toBe('rev-123');
    }
    const home = await store.transaction((tx) => store.getReadModel(tx, 'home'));
    expect((home?.payload as { archiveCount: number }).archiveCount).toBe(2);
  });

  it('refreshes a single scope only', async () => {
    const logger = createLogger({ test: 'readmodels' });
    const result = await refreshAllReadModels(store, logger, 'home');
    expect(result.refreshed).toEqual(['home']);
    expect(await store.transaction((tx) => store.getReadModel(tx, 'stats'))).toBeNull();
  });
});
