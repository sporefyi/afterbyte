/**
 * Schema-level constraint tests — no live database required.
 *
 * These assert on the Drizzle table metadata itself (unique constraints,
 * indexes, enum value sets, column types), so they run in CI without
 * Postgres. Live-database behaviour (actual violation errors) is covered
 * in tests/integration/, which skips gracefully without DATABASE_URL.
 */
import { describe, expect, it } from "vitest";
import {
  getTableConfig,
  PgNumeric,
  PgTimestamp,
  PgUUID,
  type PgTable,
} from "drizzle-orm/pg-core";

import * as s from "../src/schema.js";

function hasUniqueOn(table: PgTable, cols: string[]): boolean {
  const cfg = getTableConfig(table);
  const matches = (names: string[]) =>
    names.length === cols.length && cols.every((c) => names.includes(c));
  // 1. Table-level unique("name").on(...) constraints.
  if (
    cfg.uniqueConstraints.some((u) => matches(u.columns.map((x) => x.name)))
  ) {
    return true;
  }
  // 2. uniqueIndex(...) entries surface as indexes with unique=true.
  if (
    cfg.indexes.some(
      (i) =>
        i.config.unique &&
        matches(
          i.config.columns.flatMap((c) =>
            typeof (c as { name?: unknown }).name === "string"
              ? [(c as { name: string }).name]
              : [],
          ),
        ),
    )
  ) {
    return true;
  }
  // 3. Column-level .unique() markers live on the column itself
  //    (emitted as inline UNIQUE constraints — see the generated migration).
  if (cols.length === 1) {
    const col = cfg.columns.find((c) => c.name === cols[0]) as
      | { isUnique?: boolean }
      | undefined;
    return col?.isUnique === true;
  }
  return false;
}

interface IndexInfo {
  name: string | undefined;
  /** DB column names; SQL expressions (e.g. opclass) have no column name. */
  cols: string[];
  unique: boolean;
  method: string | undefined;
  hasWhere: boolean;
}

function indexInfos(table: PgTable): IndexInfo[] {
  return getTableConfig(table).indexes.map((i) => ({
    name: i.config.name,
    cols: i.config.columns.flatMap((c) =>
      // SQL expressions (trigram opclass etc.) carry no column name.
      typeof (c as { name?: unknown }).name === "string"
        ? [(c as { name: string }).name]
        : [],
    ),
    unique: i.config.unique,
    method: i.config.method,
    hasWhere: i.config.where !== undefined,
  }));
}

function hasIndexOn(table: PgTable, cols: string[]): boolean {
  return indexInfos(table).some(
    (i) => i.cols.length === cols.length && cols.every((c) => i.cols.includes(c)),
  );
}

function findIndex(
  table: PgTable,
  pred: (i: IndexInfo) => boolean,
): IndexInfo | undefined {
  return indexInfos(table).find(pred);
}

function column(table: PgTable, name: string) {
  const col = getTableConfig(table).columns.find((c) => c.name === name);
  expect(col, `column ${name} exists`).toBeDefined();
  return col!;
}

describe("brief §4 — database uniqueness constraints", () => {
  it("subjects.slug is unique", () => {
    expect(hasUniqueOn(s.subjects, ["slug"])).toBe(true);
  });

  it("dossier_versions unique(subject_id, version_number)", () => {
    expect(hasUniqueOn(s.dossierVersions, ["subject_id", "version_number"])).toBe(
      true,
    );
  });

  it("outbox_events.delivery_key is unique", () => {
    expect(hasUniqueOn(s.outboxEvents, ["delivery_key"])).toBe(true);
  });

  it("verified_transfers unique(chain, signature, instruction_locator)", () => {
    expect(
      hasUniqueOn(s.verifiedTransfers, ["chain", "signature", "instruction_locator"]),
    ).toBe(true);
  });

  it("bookmarks unique(user_id, subject_id)", () => {
    expect(hasUniqueOn(s.bookmarks, ["user_id", "subject_id"])).toBe(true);
  });

  it("wallet_identities unique(chain, address)", () => {
    expect(hasUniqueOn(s.walletIdentities, ["chain", "address"])).toBe(true);
  });

  it("sources.url_digest is unique (dedup key)", () => {
    expect(hasUniqueOn(s.sources, ["url_digest"])).toBe(true);
  });

  it("activity_events.sequence is unique", () => {
    expect(hasUniqueOn(s.activityEvents, ["sequence"])).toBe(true);
  });

  it("sessions.token_hash is unique", () => {
    expect(hasUniqueOn(s.sessions, ["token_hash"])).toBe(true);
  });

  it("role_grants has a partial unique index on active (user_id, role)", () => {
    const idx = findIndex(
      s.roleGrants,
      (i) =>
        i.unique &&
        i.hasWhere &&
        i.cols.length === 2 &&
        i.cols.includes("user_id") &&
        i.cols.includes("role"),
    );
    expect(idx, "partial unique index on (user_id, role)").toBeDefined();
  });
});

describe("brief §4 — required indexes", () => {
  it("dossier_versions has a publication date/status composite index", () => {
    expect(
      hasIndexOn(s.dossierVersions, [
        "published_at",
        "publication_state",
        "lifecycle_status",
      ]),
    ).toBe(true);
  });

  it("observations has a (subject_id, metric_name, observed_at) index", () => {
    expect(
      hasIndexOn(s.observations, ["subject_id", "metric_name", "observed_at"]),
    ).toBe(true);
  });

  it("outbox_events has a (state, next_attempt_at) delivery index", () => {
    expect(hasIndexOn(s.outboxEvents, ["state", "next_attempt_at"])).toBe(true);
  });

  it("research_runs has a partial pending-jobs index on state", () => {
    const idx = findIndex(
      s.researchRuns,
      (i) => i.hasWhere && i.cols.includes("state"),
    );
    expect(idx, "partial index covering state for the pending-jobs scan").toBeDefined();
  });

  it("wallet_identities has an address index", () => {
    expect(hasIndexOn(s.walletIdentities, ["address"])).toBe(true);
  });

  it("subjects has a GIN full-text index on search_vector", () => {
    const idx = findIndex(
      s.subjects,
      (i) => i.method === "gin" && i.cols.includes("search_vector"),
    );
    expect(idx, "gin search_vector index").toBeDefined();
  });

  it("claims has a GIN full-text index on search_vector", () => {
    const idx = findIndex(
      s.claims,
      (i) => i.method === "gin" && i.cols.includes("search_vector"),
    );
    expect(idx, "gin search_vector index").toBeDefined();
  });

  it("subject_external_identifiers has a trigram GIN index on aliases", () => {
    const idx = findIndex(
      s.subjectExternalIdentifiers,
      (i) =>
        i.method === "gin" &&
        (i.name?.includes("trgm") ?? false),
    );
    expect(idx, "gin trigram aliases index").toBeDefined();
  });
});

describe("brief §§4–5 — enum coverage", () => {
  it("subject_kind matches the brief's closed set", () => {
    expect(s.subjectKind.enumValues).toEqual([
      "app",
      "website",
      "game",
      "meme",
      "community",
      "crypto_project",
      "other",
    ]);
  });

  it("lifecycle_status matches brief §5", () => {
    expect(s.lifecycleStatus.enumValues).toEqual([
      "active",
      "dormant",
      "discontinued",
      "revived",
      "uncertain",
    ]);
  });

  it("editorial_state matches brief §5", () => {
    expect(s.editorialState.enumValues).toEqual([
      "draft",
      "researching",
      "ready_for_review",
      "approved",
      "published",
    ]);
  });

  it("research_run_state matches brief §5", () => {
    expect(s.researchRunState.enumValues).toEqual([
      "queued",
      "running",
      "awaiting_provider",
      "awaiting_review",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("receipt_status matches brief §9", () => {
    expect(s.receiptStatus.enumValues).toEqual([
      "pending",
      "submitted",
      "confirmed",
      "finalized",
      "failed",
      "unavailable",
    ]);
  });

  it("claim_kind matches brief §4", () => {
    expect(s.claimKind.enumValues).toEqual([
      "sourced_fact",
      "inference",
      "disputed",
      "unknown",
    ]);
  });

  it("confidence_band is a reviewed assessment, never a percentage", () => {
    expect(s.confidenceBand.enumValues).toEqual(["strong", "moderate", "limited"]);
  });

  it("event_visibility is public|internal (sanitized projection, §4)", () => {
    expect(s.eventVisibility.enumValues).toEqual(["public", "internal"]);
  });

  it("subject_visibility and event_visibility are distinct pg enums", () => {
    expect(s.subjectVisibility.enumValues).toEqual(["public", "unlisted", "hidden"]);
  });

  it("ledger_account covers the §4 journal accounts", () => {
    expect(s.ledgerAccount.enumValues).toEqual([
      "cash",
      "accounts_receivable",
      "customer_obligation",
      "recognized_revenue",
      "refund_liability",
      "reward_liability",
    ]);
  });

  it("no enum mentions tokens or tokenomics (ADR-0003)", () => {
    const allEnums = [
      s.subjectKind,
      s.subjectVisibility,
      s.editorialState,
      s.publicationKind,
      s.lifecycleStatus,
      s.confidenceBand,
      s.publicationState,
      s.researchRunState,
      s.receiptStatus,
      s.claimKind,
      s.ledgerAccount,
      s.role,
    ];
    for (const e of allEnums) {
      for (const v of e.enumValues) {
        expect(v).not.toMatch(/token/i);
      }
    }
  });
});

describe("brief §4 — column type rules", () => {
  const moneyColumns: [PgTable, string][] = [
    [s.paymentIntents, "amount"],
    [s.paymentAttempts, "amount"],
    [s.verifiedTransfers, "amount"],
    [s.refunds, "amount"],
    [s.contributorAwards, "amount"],
    [s.investigationOrders, "amount"],
    [s.ledgerEntries, "debit"],
    [s.ledgerEntries, "credit"],
    [s.researchRuns, "budget_reserved"],
    [s.researchRuns, "actual_cost"],
  ];

  it("money columns are numeric (integer base units as strings), never float", () => {
    for (const [table, name] of moneyColumns) {
      expect(
        column(table, name),
        `${getTableConfig(table).name}.${name} is PgNumeric`,
      ).toBeInstanceOf(PgNumeric);
    }
  });

  it("every table uses a UUID primary key", () => {
    const tables: PgTable[] = [
      s.subjects,
      s.subjectExternalIdentifiers,
      s.dossierDrafts,
      s.dossierVersions,
      s.timelineEvents,
      s.sources,
      s.sourceSnapshots,
      s.claims,
      s.claimEvidence,
      s.observations,
      s.subjectRelations,
      s.publicationReceipts,
      s.researchRuns,
      s.researchSteps,
      s.modelCalls,
      s.submissions,
      s.corrections,
      s.users,
      s.walletIdentities,
      s.sessions,
      s.authChallenges,
      s.roleGrants,
      s.bookmarks,
      s.watchlists,
      s.watchlistItems,
      s.notifications,
      s.homeEditions,
      s.featuredItems,
      s.assets,
      s.activityEvents,
      s.outboxEvents,
      s.investigationOrders,
      s.paymentIntents,
      s.paymentAttempts,
      s.verifiedTransfers,
      s.refunds,
      s.contributorAwards,
      s.ledgerEntries,
    ];
    for (const table of tables) {
      const pk = getTableConfig(table).columns.find((c) => c.primary);
      expect(pk, `${getTableConfig(table).name} has a PK`).toBeDefined();
      expect(pk, `${getTableConfig(table).name}.id is UUID`).toBeInstanceOf(PgUUID);
    }
  });

  it("created_at columns are timestamptz (UTC)", () => {
    for (const table of [s.subjects, s.dossierVersions, s.outboxEvents, s.users]) {
      const col = column(table, "created_at");
      expect(col).toBeInstanceOf(PgTimestamp);
      expect(
        (col as unknown as { withTimezone: boolean }).withTimezone,
        `${getTableConfig(table).name}.created_at has timezone`,
      ).toBe(true);
    }
  });

  it("explicit foreign keys exist on core relations", () => {
    expect(getTableConfig(s.dossierVersions).foreignKeys.length).toBeGreaterThan(0);
    expect(getTableConfig(s.claimEvidence).foreignKeys.length).toBe(2);
    expect(getTableConfig(s.paymentAttempts).foreignKeys.length).toBe(1);
  });
});
