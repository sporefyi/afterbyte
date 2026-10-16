import { customType, numeric, timestamp } from "drizzle-orm/pg-core";

/**
 * Shared column helpers for the AFTERBYTE schema.
 *
 * Money rule (brief §4): monetary quantities are INTEGER BASE UNITS,
 * represented as decimal strings in JSON. Never floating-point money.
 * We model this as numeric(38,0), which drizzle-orm returns as a string.
 */
export function money(name: string) {
  return numeric(name, { precision: 38, scale: 0 });
}

/** Nullable money column (e.g. cost recorded after completion). */
export function moneyNullable(name: string) {
  return numeric(name, { precision: 38, scale: 0 });
}

/** UTC timestamptz, per brief §4. */
export function tstz(name: string) {
  return timestamp(name, { withTimezone: true });
}

/** NOT NULL created_at with DB-side default. */
export function createdAt() {
  return tstz("created_at").notNull().defaultNow();
}

/** updated_at maintained by application/trigger; defaults to now on insert. */
export function updatedAt() {
  return tstz("updated_at").notNull().defaultNow();
}

/**
 * Postgres tsvector column for GIN full-text search (brief §4: "GIN full-text
 * index"). Always populated via GENERATED ALWAYS AS (to_tsvector(...)) STORED
 * so the search index can never drift from the source text.
 */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
