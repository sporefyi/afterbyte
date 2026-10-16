#!/usr/bin/env node
/**
 * Synthetic demo seed — CLEARLY LABELLED fixtures only.
 *
 * Every row created here is visibly fake: names carry a "[DEMO]" prefix,
 * slugs are "demo-*", and descriptions start with "[SYNTHETIC DEMO DATA]".
 * Nothing here represents a real app, site, game, meme, community or
 * crypto project. Safe to run in dev; never run against production.
 *
 * Idempotent: re-running skips rows whose unique keys already exist.
 *
 * Usage: pnpm seed   (requires DATABASE_URL + migrated schema: pnpm migrate)
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { createDb } from "./db.js";
import * as s from "./schema.js";

const DEMO = "[SYNTHETIC DEMO DATA — not real] ";
const ZERO_HASH = "00".repeat(32);

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Deterministic demo UUIDs so re-runs are idempotent. */
const ID = {
  subjectPixelpond: "11111111-1111-4111-8111-111111111111",
  subjectChatlantern: "22222222-2222-4222-8222-222222222222",
  subjectMemevault: "33333333-3333-4333-8333-333333333333",
  versionPp1: "11111111-1111-4111-8111-1111111111a1",
  versionPp2: "11111111-1111-4111-8111-1111111111a2",
  versionCl1: "22222222-2222-4222-8222-2222222222b1",
  versionMv1: "33333333-3333-4333-8333-3333333333c1",
  sourcePpOfficial: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  sourcePpWiki: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  sourceClBlog: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  snapPp1: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
  snapPp2: "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2",
  snapCl1: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1",
  claimPp1: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1",
  claimPp2: "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2",
  claimCl1: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
  claimMv1: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  demoUser: "99999999-9999-4999-8999-999999999999",
  runPp: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
  outboxPp: "0b0b0b0b-0b0b-40b0-80b0-0b0b0b0b0b0b",
  activityPp: "0a0a0a0a-0a0a-40a0-80a0-0a0a0a0a0a0a",
  edition: "ed1ed1ed-1ed1-41ed-81ed-ed1ed1ed1ed1",
} as const;

const NOW = new Date("2026-10-16T09:00:00Z");

async function main(): Promise<void> {
  const { pool, db } = createDb();
  try {
    // --- demo user (clearly fake) -------------------------------------
    await db
      .insert(s.users)
      .values({
        id: ID.demoUser,
        displayName: "[DEMO] Demo Editor",
        email: "demo.editor@example.invalid",
      })
      .onConflictDoNothing();

    // --- subjects ------------------------------------------------------
    const subjects = [
      {
        id: ID.subjectPixelpond,
        slug: "demo-pixelpond",
        canonicalName: "[DEMO] PixelPond",
        aliases: ["[DEMO] Pixel Pond", "demo-pixel-pond"],
        kind: "game" as const,
        shortDescription:
          `${DEMO}A fictional pixel-art pond simulator discontinued by its ` +
          `imaginary studio in 2024. All dates, claims and sources are invented.`,
        firstKnownDate: "2021",
        datePrecision: "year" as const,
        officialUrls: ["https://pixelpond.example.invalid"],
        visibility: "public" as const,
      },
      {
        id: ID.subjectChatlantern,
        slug: "demo-chatlantern",
        canonicalName: "[DEMO] ChatLantern",
        aliases: ["[DEMO] Chat Lantern"],
        kind: "app" as const,
        shortDescription:
          `${DEMO}A fictional lantern-themed chat app that went dormant in ` +
          `2025. All dates, claims and sources are invented.`,
        firstKnownDate: "2022-03",
        datePrecision: "month" as const,
        officialUrls: ["https://chatlantern.example.invalid"],
        visibility: "public" as const,
      },
      {
        id: ID.subjectMemevault,
        slug: "demo-memevault",
        canonicalName: "[DEMO] MemeVault",
        aliases: ["[DEMO] Meme Vault"],
        kind: "meme" as const,
        shortDescription:
          `${DEMO}A fictional image-macro meme format from 2023. All dates, ` +
          `claims and sources are invented.`,
        firstKnownDate: "2023",
        datePrecision: "year" as const,
        officialUrls: [],
        visibility: "public" as const,
      },
    ];
    for (const row of subjects) {
      await db.insert(s.subjects).values(row).onConflictDoNothing();
    }

    // --- dossier versions (immutable; v1 chains from the zero hash) ----
    const versions = [
      {
        id: ID.versionPp1,
        subjectId: ID.subjectPixelpond,
        versionNumber: 1,
        publicationKind: "initial" as const,
        publicPayloadHash: sha256hex("demo-pixelpond-v1"),
        previousPayloadHash: ZERO_HASH,
        canonicalObjectKey: "demo/pixelpond/v1.json",
        hashSchemaVersion: 1,
        lifecycleStatus: "discontinued" as const,
        statusReason:
          `${DEMO}Fictional studio sunset post dated 2024-02 (invented).`,
        confidenceBand: "moderate" as const,
        confidenceReason: `${DEMO}Two invented sources agree; no primary confirmation.`,
        reviewedAt: NOW,
        reviewedBy: ID.demoUser,
        intendedPublishedAt: NOW,
        publishedAt: NOW,
        nextReviewAt: new Date("2027-02-01T00:00:00Z"),
        publicationState: "published" as const,
      },
      {
        id: ID.versionPp2,
        subjectId: ID.subjectPixelpond,
        versionNumber: 2,
        publicationKind: "correction" as const,
        publicPayloadHash: sha256hex("demo-pixelpond-v2"),
        previousPayloadHash: sha256hex("demo-pixelpond-v1"),
        canonicalObjectKey: "demo/pixelpond/v2.json",
        hashSchemaVersion: 1,
        lifecycleStatus: "discontinued" as const,
        statusReason: `${DEMO}Corrected invented shutdown month.`,
        confidenceBand: "moderate" as const,
        confidenceReason: `${DEMO}Same invented sources, date clarified.`,
        reviewedAt: NOW,
        reviewedBy: ID.demoUser,
        intendedPublishedAt: NOW,
        publishedAt: NOW,
        nextReviewAt: new Date("2027-02-01T00:00:00Z"),
        publicationState: "published" as const,
      },
      {
        id: ID.versionCl1,
        subjectId: ID.subjectChatlantern,
        versionNumber: 1,
        publicationKind: "initial" as const,
        publicPayloadHash: sha256hex("demo-chatlantern-v1"),
        previousPayloadHash: ZERO_HASH,
        canonicalObjectKey: "demo/chatlantern/v1.json",
        hashSchemaVersion: 1,
        lifecycleStatus: "dormant" as const,
        statusReason:
          `${DEMO}No invented activity observed for 9 months; no closure statement.`,
        confidenceBand: "limited" as const,
        confidenceReason: `${DEMO}Single invented source; absence is not proof.`,
        reviewedAt: NOW,
        reviewedBy: ID.demoUser,
        intendedPublishedAt: NOW,
        publishedAt: NOW,
        nextReviewAt: new Date("2026-11-16T00:00:00Z"),
        publicationState: "published" as const,
      },
      {
        id: ID.versionMv1,
        subjectId: ID.subjectMemevault,
        versionNumber: 1,
        publicationKind: "initial" as const,
        publicPayloadHash: sha256hex("demo-memevault-v1"),
        previousPayloadHash: ZERO_HASH,
        canonicalObjectKey: "demo/memevault/v1.json",
        hashSchemaVersion: 1,
        lifecycleStatus: "uncertain" as const,
        statusReason: `${DEMO}Conflicting invented accounts of origin.`,
        confidenceBand: "limited" as const,
        confidenceReason: `${DEMO}Invented sources disagree.`,
        reviewedAt: NOW,
        reviewedBy: ID.demoUser,
        intendedPublishedAt: NOW,
        publishedAt: NOW,
        nextReviewAt: new Date("2026-11-16T00:00:00Z"),
        publicationState: "published" as const,
      },
    ];
    for (const row of versions) {
      await db.insert(s.dossierVersions).values(row).onConflictDoNothing();
    }

    // Point subjects at their current published versions.
    await db
      .update(s.subjects)
      .set({ currentPublishedVersionId: ID.versionPp2 })
      .where(eqId(s.subjects, ID.subjectPixelpond));
    await db
      .update(s.subjects)
      .set({ currentPublishedVersionId: ID.versionCl1 })
      .where(eqId(s.subjects, ID.subjectChatlantern));
    await db
      .update(s.subjects)
      .set({ currentPublishedVersionId: ID.versionMv1 })
      .where(eqId(s.subjects, ID.subjectMemevault));

    // --- sources + snapshots -------------------------------------------
    const sources = [
      {
        id: ID.sourcePpOfficial,
        canonicalUrl: "https://pixelpond.example.invalid/sunset",
        urlDigest: sha256hex("https://pixelpond.example.invalid/sunset"),
        domain: "pixelpond.example.invalid",
        publisher: "[DEMO] Imaginary Pond Studio",
        sourceType: "official_site" as const,
        fetchPolicy: "demo",
        licenceOrPermissionNote: `${DEMO}Invented source; no real licence.`,
        availability: "available" as const,
      },
      {
        id: ID.sourcePpWiki,
        canonicalUrl: "https://wiki.example.invalid/PixelPond",
        urlDigest: sha256hex("https://wiki.example.invalid/PixelPond"),
        domain: "wiki.example.invalid",
        publisher: "[DEMO] Example Wiki",
        sourceType: "wikipedia" as const,
        fetchPolicy: "demo",
        licenceOrPermissionNote: `${DEMO}Invented source; no real licence.`,
        availability: "available" as const,
      },
      {
        id: ID.sourceClBlog,
        canonicalUrl: "https://chatlantern.example.invalid/blog/hiatus",
        urlDigest: sha256hex("https://chatlantern.example.invalid/blog/hiatus"),
        domain: "chatlantern.example.invalid",
        publisher: "[DEMO] Lantern Labs (fictional)",
        sourceType: "official_site" as const,
        fetchPolicy: "demo",
        licenceOrPermissionNote: `${DEMO}Invented source; no real licence.`,
        availability: "unavailable" as const,
      },
    ];
    for (const row of sources) {
      await db.insert(s.sources).values(row).onConflictDoNothing();
    }

    const snapshots = [
      {
        id: ID.snapPp1,
        sourceId: ID.sourcePpOfficial,
        fetchedAt: NOW,
        httpStatus: 200,
        contentType: "text/html",
        rawDigest: sha256hex("demo-raw-pp1"),
        normalizedDigest: sha256hex("demo-norm-pp1"),
        privateObjectKey: "demo/private/pixelpond/snap1.bin",
        publicExcerpt: `${DEMO}“Thanks for playing — servers close March 2024.” (invented excerpt)`,
        parserVersion: "demo-1",
        availability: "success" as const,
        finalUrl: "https://pixelpond.example.invalid/sunset",
      },
      {
        id: ID.snapPp2,
        sourceId: ID.sourcePpWiki,
        fetchedAt: NOW,
        httpStatus: 200,
        contentType: "text/html",
        rawDigest: sha256hex("demo-raw-pp2"),
        normalizedDigest: sha256hex("demo-norm-pp2"),
        privateObjectKey: "demo/private/pixelpond/snap2.bin",
        publicExcerpt: `${DEMO}“PixelPond was a 2021 pond simulator.” (invented excerpt)`,
        parserVersion: "demo-1",
        availability: "success" as const,
        finalUrl: "https://wiki.example.invalid/PixelPond",
      },
      {
        id: ID.snapCl1,
        sourceId: ID.sourceClBlog,
        fetchedAt: NOW,
        httpStatus: 404,
        contentType: null,
        rawDigest: null,
        normalizedDigest: null,
        privateObjectKey: null,
        publicExcerpt: null,
        parserVersion: "demo-1",
        availability: "http_error" as const,
        finalUrl: "https://chatlantern.example.invalid/blog/hiatus",
      },
    ];
    for (const row of snapshots) {
      await db.insert(s.sourceSnapshots).values(row).onConflictDoNothing();
    }

    // --- claims + evidence ----------------------------------------------
    const claims = [
      {
        id: ID.claimPp1,
        subjectId: ID.subjectPixelpond,
        containerKind: "version" as const,
        containerId: ID.versionPp2,
        claimText: `${DEMO}PixelPond's fictional studio announced a shutdown in early 2024.`,
        claimKind: "sourced_fact" as const,
        reviewState: "accepted" as const,
        reviewerNote: `${DEMO}Accepted against invented snapshot.`,
      },
      {
        id: ID.claimPp2,
        subjectId: ID.subjectPixelpond,
        containerKind: "version" as const,
        containerId: ID.versionPp2,
        claimText: `${DEMO}PixelPond may have had around 10,000 fictional players.`,
        claimKind: "inference" as const,
        reviewState: "pending" as const,
        reviewerNote: null,
      },
      {
        id: ID.claimCl1,
        subjectId: ID.subjectChatlantern,
        containerKind: "version" as const,
        containerId: ID.versionCl1,
        claimText: `${DEMO}ChatLantern's fictional blog is unreachable (HTTP 404); this alone proves nothing about shutdown.`,
        claimKind: "sourced_fact" as const,
        reviewState: "accepted" as const,
        reviewerNote: `${DEMO}A failed fetch is an observation, not proof of cessation.`,
      },
      {
        id: ID.claimMv1,
        subjectId: ID.subjectMemevault,
        containerKind: "version" as const,
        containerId: ID.versionMv1,
        claimText: `${DEMO}MemeVault's origin is disputed between two invented accounts.`,
        claimKind: "disputed" as const,
        reviewState: "disputed" as const,
        reviewerNote: null,
      },
    ];
    for (const row of claims) {
      await db.insert(s.claims).values(row).onConflictDoNothing();
    }

    const evidence = [
      {
        claimId: ID.claimPp1,
        sourceSnapshotId: ID.snapPp1,
        excerpt: `${DEMO}“servers close March 2024” (invented)`,
        locator: "body > main > p:nth-child(2)",
        relationship: "supports" as const,
      },
      {
        claimId: ID.claimPp1,
        sourceSnapshotId: ID.snapPp2,
        excerpt: `${DEMO}“shut down in 2024” (invented)`,
        locator: "table.infobox > tr:nth-child(5)",
        relationship: "supports" as const,
      },
      {
        claimId: ID.claimCl1,
        sourceSnapshotId: ID.snapCl1,
        excerpt: null,
        locator: null,
        relationship: "supports" as const,
      },
    ];
    for (const row of evidence) {
      await db.insert(s.claimEvidence).values(row).onConflictDoNothing();
    }

    // --- timeline ---------------------------------------------------------
    const timeline = [
      {
        subjectId: ID.subjectPixelpond,
        containerKind: "version" as const,
        containerId: ID.versionPp2,
        eventType: "launch",
        title: `${DEMO}PixelPond launches (fictional)`,
        summary: `${DEMO}Invented launch event.`,
        dateStart: "2021",
        dateEnd: null,
        datePrecision: "year" as const,
        sourceClaimIds: [ID.claimPp1],
        displayOrder: 0,
      },
      {
        subjectId: ID.subjectPixelpond,
        containerKind: "version" as const,
        containerId: ID.versionPp2,
        eventType: "shutdown",
        title: `${DEMO}Fictional sunset announcement`,
        summary: `${DEMO}Invented shutdown event.`,
        dateStart: "2024-02",
        dateEnd: "2024-03",
        datePrecision: "month" as const,
        sourceClaimIds: [ID.claimPp1],
        displayOrder: 1,
      },
    ];
    for (const row of timeline) {
      await db.insert(s.timelineEvents).values(row).onConflictDoNothing();
    }

    // --- observations (one real-shaped metric row) -------------------------
    await db
      .insert(s.observations)
      .values({
        subjectId: ID.subjectPixelpond,
        sourceSnapshotId: ID.snapPp2,
        observedAt: NOW,
        measurementWindow: "[2024-01-01,2024-02-01)",
        metricName: "demo.monthly_active_fictional_players",
        value: "10000",
        unit: "fictional_players",
        provider: "demo",
        collectionMethod: "demo",
        qualityFlag: "estimated",
      })
      .onConflictDoNothing();

    // --- research run + outbox + activity (pipeline-shaped demo rows) -------
    await db
      .insert(s.researchRuns)
      .values({
        id: ID.runPp,
        subjectId: ID.subjectPixelpond,
        trigger: "demo",
        workflowVersion: "demo-1",
        state: "completed",
        stage: "draft",
        budgetReserved: "0",
        actualCost: "0",
        startedAt: NOW,
        heartbeatAt: NOW,
        completedAt: NOW,
      })
      .onConflictDoNothing();

    await db
      .insert(s.outboxEvents)
      .values({
        id: ID.outboxPp,
        eventType: "demo.dossier.published",
        aggregateId: ID.versionPp2,
        aggregateRevision: 2,
        payload: { demo: true, note: `${DEMO}delivered demo event` },
        visibility: "public",
        state: "delivered",
        deliveryKey: `demo:dossier-published:${ID.versionPp2}`,
        attempts: 1,
        dispatchedAt: NOW,
      })
      .onConflictDoNothing();

    await db
      .insert(s.activityEvents)
      .values({
        id: ID.activityPp,
        eventType: "demo.dossier.published",
        aggregateId: ID.versionPp2,
        aggregateRevision: 2,
        occurredAt: NOW,
        visibility: "public",
        payload: {
          demo: true,
          subjectSlug: "demo-pixelpond",
          note: `${DEMO}sanitized public demo activity`,
        },
      })
      .onConflictDoNothing();

    // --- homepage demo edition ----------------------------------------------
    await db
      .insert(s.homeEditions)
      .values({
        id: ID.edition,
        editionDate: "2026-10-16",
        title: "[DEMO] Demo edition",
        state: "published",
        publishedAt: NOW,
      })
      .onConflictDoNothing();

    console.log("seed complete: 3 demo subjects (+ versions, sources, claims, evidence, timeline, observations, run, outbox, activity, edition).");
    console.log("ALL ROWS ARE SYNTHETIC AND CLEARLY LABELLED [DEMO].");
  } finally {
    await pool.end();
  }
}

/** Minimal eq helper to avoid repeating drizzle-orm generics in seed. */
function eqId(table: { id: unknown }, id: string) {
  return eq(table.id as never, id as never);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
