# @afterbyte/database — Lane 1: database

Drizzle ORM schema, migrations, seed and db client for the AFTERBYTE backend.
Implements brief §4 (domain model + index list), §§5/8/9 state rules, and
ADR-0001/0002/0003.

## Layout

- `src/schema/` — table definitions, split by domain and re-exported from
  `src/schema.ts`: `core.ts` (subjects, dossiers, timeline, sources, claims,
  observations, relations, publication receipts), `research.ts` (runs, steps,
  model calls, submissions, corrections), `auth.ts` (users, wallets, sessions,
  challenges, role grants), `engagement.ts` (bookmarks, watchlists,
  notifications, home editions, assets, activity + outbox events),
  `payments.ts` (Release B interfaces behind `PAYMENTS_ENABLED=false`).
- `src/relations.ts` — drizzle relational-query relations.
- `src/db.ts` — `createDb()` / `getDb()` / `closeDb()` from `DATABASE_URL`.
- `src/migrate.ts` — applies `drizzle/` migrations (`pnpm migrate`).
- `src/seed.ts` — **synthetic, clearly-labelled `[DEMO]` fixtures only**
  (3 demo subjects + versions/sources/claims/evidence/timeline; idempotent).
- `drizzle/` — generated migration + snapshot (`pnpm db:generate`).
  The initial migration has `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
  prepended by hand (drizzle-kit does not emit it); documented in
  `drizzle.config.ts`.
- `tests/schema.test.ts` — constraint/enum/index/type assertions, **no live
  DB required**.
- `tests/integration/db.test.ts` — live-Postgres violation tests; skipped
  gracefully when `DATABASE_URL` is unset (point it at a scratch DB — the
  test applies migrations first).

## Rules enforced

- UUID PKs, `timestamptz` (UTC) instants, Postgres enums for closed sets.
- Money = `numeric(38,0)` → decimal strings in JSON; never floats.
- Unique slug + URL digest dedup; `unique(subject_id, version_number)`;
  outbox `delivery_key` unique (at-most-once business effects);
  `unique(chain, signature, instruction_locator)` on verified transfers;
  balanced-journal `CHECK` on ledger entries.
- No token, no ticker, no tokenomics anywhere (ADR-0003).

## Scripts

`build` · `typecheck` · `test` · `migrate` · `seed` · `db:generate` · `db:push`
