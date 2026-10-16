import type { PublishedSubjectRow } from './types.js';
import type { ReadModelStore } from './db.js';
import type { Logger } from './logging.js';

export interface HomeReadModel extends Record<string, unknown> {
  archiveCount: number;
  activeCount: number;
  recordedCount: number;
}

export interface CollectionReadModel extends Record<string, unknown> {
  subjectCount: number;
  byStatus: Record<string, number>;
}

export interface StatsReadModel extends Record<string, unknown> {
  totalVersions: number;
  totalFinalizedReceipts: number;
}

/**
 * Home read model (brief §14). Built from published data only: retracted
 * currents and rows with no published version are excluded from every count.
 * "recorded" = versions with finalized receipts.
 */
export function buildHomeReadModel(subjects: PublishedSubjectRow[]): HomeReadModel {
  const published = subjects.filter(
    (s) => !s.isRetracted && s.currentVersionNumber !== null,
  );

  const archiveCount = published.filter(
    (s) => s.currentVersionNumber !== null,
  ).length;

  const activeCount = published.filter(
    (s) => s.lifecycleStatus === 'active' && !s.isRetracted,
  ).length;

  const recordedCount = published.reduce(
    (sum, s) => sum + (s.versionsWithFinalizedReceipts ?? 0),
    0,
  );

  return { archiveCount, activeCount, recordedCount };
}

export function buildCollectionReadModel(
  subjects: PublishedSubjectRow[],
): CollectionReadModel {
  const published = subjects.filter(
    (s) => !s.isRetracted && s.currentVersionNumber !== null,
  );

  const subjectCount = published.length;

  const byStatus: Record<string, number> = {};
  for (const subject of published) {
    const status = subject.lifecycleStatus ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return { subjectCount, byStatus };
}

export function buildStatsReadModel(
  subjects: PublishedSubjectRow[],
): StatsReadModel {
  const published = subjects.filter(
    (s) => !s.isRetracted && s.currentVersionNumber !== null,
  );

  const totalVersions = published.reduce(
    (sum, s) => sum + (s.currentVersionNumber ?? 0),
    0,
  );

  const totalFinalizedReceipts = published.reduce(
    (sum, s) => sum + (s.versionsWithFinalizedReceipts ?? 0),
    0,
  );

  return { totalVersions, totalFinalizedReceipts };
}

export async function refreshAllReadModels(
  store: ReadModelStore,
  logger: Logger,
  scope: 'home' | 'collection' | 'stats' | 'all',
  now: () => string = () => new Date().toISOString(),
): Promise<{ refreshed: string[]; sourceRevision: string }> {
  // Read + materialize inside ONE transaction so asOf/sourceRevision describe
  // exactly the data the models were built from.
  return store.transaction(async (tx) => {
    const subjects = await store.listPublishedSubjects(tx);
    const sourceRevision = await store.currentSourceRevision(tx);
    const asOf = now();
    const refreshed: string[] = [];

    if (scope === 'home' || scope === 'all') {
      await store.upsertReadModel(tx, {
        key: 'home',
        payload: buildHomeReadModel(subjects),
        asOf,
        sourceRevision,
      });
      refreshed.push('home');
    }

    if (scope === 'collection' || scope === 'all') {
      await store.upsertReadModel(tx, {
        key: 'collection',
        payload: buildCollectionReadModel(subjects),
        asOf,
        sourceRevision,
      });
      refreshed.push('collection');
    }

    if (scope === 'stats' || scope === 'all') {
      await store.upsertReadModel(tx, {
        key: 'stats',
        payload: buildStatsReadModel(subjects),
        asOf,
        sourceRevision,
      });
      refreshed.push('stats');
    }

    logger.info('read models refreshed', { refreshed, sourceRevision, asOf });
    return { refreshed, sourceRevision };
  });
}
