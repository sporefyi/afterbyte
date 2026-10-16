/**
 * Live-Postgres constraint tests.
 *
 * Skipped gracefully when DATABASE_URL is unset (schema-level behaviour is
 * covered in tests/schema.test.ts without a database). When DATABASE_URL is
 * set, migrations are applied first — point it at a SCRATCH database, never
 * production.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb, closeDb, type Db } from "../../src/db.js";
import * as s from "../../src/schema.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("live postgres constraints", () => {
  let db: Db;

  beforeAll(async () => {
    ({ db } = createDb());
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  it("rejects a duplicate subject slug", async () => {
    const slug = `test-dup-${randomUUID().slice(0, 8)}`;
    await db.insert(s.subjects).values({
      slug,
      canonicalName: "Test Dup",
      kind: "app",
    });
    await expect(
      db.insert(s.subjects).values({ slug, canonicalName: "Test Dup 2", kind: "app" }),
    ).rejects.toThrow(/duplicate|unique|23505/i);
  });

  it("rejects a duplicate (subject_id, version_number)", async () => {
    const subjectId = randomUUID();
    await db.insert(s.subjects).values({
      id: subjectId,
      slug: `test-ver-${randomUUID().slice(0, 8)}`,
      canonicalName: "Test Ver",
      kind: "app",
    });
    const base = {
      subjectId,
      versionNumber: 1,
      publicationKind: "initial" as const,
      publicPayloadHash: "ab".repeat(32),
      previousPayloadHash: "00".repeat(32),
      canonicalObjectKey: `test/${randomUUID()}.json`,
      lifecycleStatus: "uncertain" as const,
      statusReason: "test",
    };
    await db.insert(s.dossierVersions).values(base);
    await expect(
      db
        .insert(s.dossierVersions)
        .values({ ...base, canonicalObjectKey: `test/${randomUUID()}.json` }),
    ).rejects.toThrow(/duplicate|unique|23505/i);
  });

  it("rejects an invalid enum value at the database", async () => {
    // Deliberately bypass the compile-time enum check to prove Postgres
    // itself rejects the value (defense in depth: app + DB both enforce).
    const badRow = {
      trigger: "test",
      workflowVersion: "test-1",
      state: "exploding",
    } as unknown as typeof s.researchRuns.$inferInsert;
    await expect(db.insert(s.researchRuns).values(badRow)).rejects.toThrow();
  });

  it("rejects a duplicate outbox delivery_key", async () => {
    const key = `test-delivery-${randomUUID()}`;
    const row = {
      eventType: "test.event",
      aggregateId: randomUUID(),
      aggregateRevision: 1,
      payload: {},
      deliveryKey: key,
    };
    await db.insert(s.outboxEvents).values(row);
    await expect(db.insert(s.outboxEvents).values(row)).rejects.toThrow(
      /duplicate|unique|23505/i,
    );
  });

  it("rejects a duplicate verified transfer (chain, signature, locator)", async () => {
    const sig = `test-sig-${randomUUID()}`;
    const row = {
      chain: "solana",
      signature: sig,
      instructionLocator: "0",
      amount: "1000",
    };
    await db.insert(s.verifiedTransfers).values(row);
    await expect(db.insert(s.verifiedTransfers).values(row)).rejects.toThrow(
      /duplicate|unique|23505/i,
    );
  });

  it("stores money as integer base-unit strings, not floats", async () => {
    const id = randomUUID();
    const userId = randomUUID();
    await db.insert(s.users).values({ id: userId, displayName: "Test" });
    await db.insert(s.paymentIntents).values({
      id,
      userId,
      purpose: "test",
      amount: "250000",
    });
    const rows = await db
      .select({ amount: s.paymentIntents.amount })
      .from(s.paymentIntents)
      .where(eq(s.paymentIntents.id, id));
    expect(rows[0]?.amount).toBe("250000");
    expect(typeof rows[0]?.amount).toBe("string");
  });

  it("enforces the ledger single-sided check", async () => {
    await expect(
      db.insert(s.ledgerEntries).values({
        journalGroup: randomUUID(),
        account: "cash",
        debit: "100",
        credit: "100",
      }),
    ).rejects.toThrow(/single_sided|check|23514/i);
  });
});

async function teardown() {
  await closeDb();
}

describeDb("teardown", () => {
  it("closes the pool", async () => {
    await teardown();
  });
});
