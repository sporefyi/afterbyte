/**
 * Cursor pagination per brief §12: deterministic ordering with an ID
 * tiebreaker, default limit 24, max 100. The cursor is an opaque base64url
 * encoding of the last seen (sortKey, id) pair plus the active sort/filter
 * context, so a stale or foreign cursor cannot silently change results —
 * it either decodes to the same context or is rejected.
 */

export const DEFAULT_LIMIT = 24;
export const MAX_LIMIT = 100;

export interface PageOptions {
  limit?: number;
  cursor?: string;
}

export interface CursorPayload {
  v: 1;
  /** last seen sort key (already serialized deterministically) */
  k: string;
  /** last seen row id (tiebreaker) */
  id: string;
  /** active sort/filter context the cursor was issued under */
  ctx: Record<string, string>;
}

export interface ParsedCursor {
  sortKey: string;
  id: string;
  ctx: Record<string, string>;
}

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export function encodeCursor(payload: Omit<CursorPayload, 'v'>): string {
  const full: CursorPayload = { v: 1, ...payload };
  return Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
}

/** Returns null when the cursor is malformed, foreign, or from another context. */
export function decodeCursor(cursor: string, ctx: Record<string, string>): ParsedCursor | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Partial<CursorPayload>;
  if (p.v !== 1 || typeof p.k !== 'string' || typeof p.id !== 'string') return null;
  const c = (p.ctx ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(ctx)) {
    if (c[key] !== value) return null; // cursor issued under different filters
  }
  return { sortKey: p.k, id: p.id, ctx: c };
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Generic in-memory page helper. `rows` must already be sorted by
 * (sortKey, id) ascending. `sortKeyOf` extracts the deterministic sort key.
 * `ctxOf` extracts the filter context (must match what the cursor carries).
 */
export function paginateRows<T>(
  rows: T[],
  opts: PageOptions,
  ctx: Record<string, string>,
  idOf: (row: T) => string,
  sortKeyOf: (row: T) => string,
): PageResult<T> {
  const limit = normalizeLimit(opts.limit);
  let start = 0;
  if (opts.cursor) {
    const parsed = decodeCursor(opts.cursor, ctx);
    if (!parsed) {
      throw Object.assign(new Error('invalid cursor'), { code: 'VALIDATION_FAILED' });
    }
    start = rows.findIndex(
      (r) => sortKeyOf(r) > parsed.sortKey || (sortKeyOf(r) === parsed.sortKey && idOf(r) > parsed.id),
    );
    if (start === -1) start = rows.length;
  }
  const page = rows.slice(start, start + limit);
  const nextCursor =
    start + limit < rows.length
      ? encodeCursor({ k: sortKeyOf(page[page.length - 1]), id: idOf(page[page.length - 1]), ctx })
      : null;
  return { items: page, nextCursor };
}
