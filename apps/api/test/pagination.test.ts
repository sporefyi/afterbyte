import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, paginateRows, normalizeLimit, DEFAULT_LIMIT, MAX_LIMIT } from '../src/lib/pagination.js';

const rows = [
  { id: 'a', k: '2026-01-01' },
  { id: 'b', k: '2026-01-01' }, // same sort key: id tiebreaker
  { id: 'c', k: '2026-01-02' },
  { id: 'd', k: '2026-01-03' },
];
const idOf = (r: (typeof rows)[number]) => r.id;
const keyOf = (r: (typeof rows)[number]) => r.k;

describe('pagination', () => {
  it('defaults limit to 24 and caps at 100', () => {
    expect(normalizeLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(normalizeLimit(0)).toBe(DEFAULT_LIMIT);
    expect(normalizeLimit(500)).toBe(MAX_LIMIT);
    expect(normalizeLimit(10)).toBe(10);
  });

  it('pages deterministically with the id tiebreaker', () => {
    const ctx = { sort: 'relevance' };
    const p1 = paginateRows(rows, { limit: 2 }, ctx, idOf, keyOf);
    expect(p1.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = paginateRows(rows, { limit: 2, cursor: p1.nextCursor! }, ctx, idOf, keyOf);
    expect(p2.items.map((r) => r.id)).toEqual(['c', 'd']);
    expect(p2.nextCursor).toBeNull();
  });

  it('rejects a cursor issued under different filters', () => {
    const cursor = encodeCursor({ k: '2026-01-01', id: 'a', ctx: { sort: 'relevance' } });
    expect(decodeCursor(cursor, { sort: 'relevance' })).not.toBeNull();
    expect(decodeCursor(cursor, { sort: 'recently_updated' })).toBeNull();
    expect(decodeCursor('not-a-cursor', { sort: 'relevance' })).toBeNull();
  });

  it('throws VALIDATION_FAILED on a foreign cursor', () => {
    expect(() => paginateRows(rows, { limit: 2, cursor: 'bogus' }, { sort: 'x' }, idOf, keyOf)).toThrow();
  });
});
