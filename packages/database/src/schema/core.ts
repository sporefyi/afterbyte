import { sql } from "drizzle-orm";
import {
  AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, tstz, tsvector, updatedAt } from "./_common.js";

/* ------------------------------------------------------------------ */
/* Enums (closed sets from brief §§4–5; enforced as Postgres enums)      */
/* ------------------------------------------------------------------ */

export const subjectKind = pgEnum("subject_kind", [
  "app",
  "website",
  "game",
  "meme",
  "community",
  "crypto_project",
  "other",
]);

/** Distinct from event_visibility below: subjects have three levels. */
export const subjectVisibility = pgEnum("subject_visibility", [
  "public",
  "unlisted",
  "hidden",
]);

export const datePrecision = pgEnum("date_precision", [
  "year",
  "month",
  "day",
  "approximate",
]);

/** §5: draft -> researching -> ready_for_review -> approved -> published */
export const editorialState = pgEnum("editorial_state", [
  "draft",
  "researching",
  "ready_for_review",
  "approved",
  "published",
]);

export const publicationKind = pgEnum("publication_kind", [
  "initial",
  "update",
  "correction",
  "retraction_notice",
]);

/** §5 lifecycle status; every value requires a status_reason. */
export const lifecycleStatus = pgEnum("lifecycle_status", [
  "active",
  "dormant",
  "discontinued",
  "revived",
  "uncertain",
]);

/** §5: reviewed evidence assessment — never an uncalibrated AI percentage. */
export const confidenceBand = pgEnum("confidence_band", [
  "strong",
  "moderate",
  "limited",
]);

export const publicationState = pgEnum("publication_state", [
  "published",
  "retracted",
]);

/**
 * timeline_events and claims attach to either a working draft or an immutable
 * published version. Polymorphic by design; the FK is enforced at the
 * application layer (documented here) because a single column cannot
 * reference two tables.
 */
export const contentContainerKind = pgEnum("content_container_kind", [
  "draft",
  "version",
]);

export const sourceType = pgEnum("source_type", [
  "official_site",
  "rss_feed",
  "github",
  "wikipedia",
  "archive",
  "social",
  "search_result",
  "other",
]);

export const sourceAvailability = pgEnum("source_availability", [
  "available",
  "unavailable",
  "restricted",
]);

/** §4: an unsuccessful fetch is an observation, not proof of cessation. */
export const snapshotAvailability = pgEnum("snapshot_availability", [
  "success",
  "http_error",
  "network_error",
  "blocked",
  "timeout",
]);

export const claimKind = pgEnum("claim_kind", [
  "sourced_fact",
  "inference",
  "disputed",
  "unknown",
]);

export const claimReviewState = pgEnum("claim_review_state", [
  "pending",
  "accepted",
  "disputed",
  "rejected",
]);

export const evidenceRelationship = pgEnum("evidence_relationship", [
  "supports",
  "contradicts",
]);

/** §4: collection failure is not zero — failed collections keep value NULL. */
export const qualityFlag = pgEnum("quality_flag", [
  "verified",
  "estimated",
  "suspect",
  "collection_failed",
]);

export const relationshipType = pgEnum("relationship_type", [
  "successor",
  "fork",
  "inspired_by",
  "revival_of",
  "other",
]);

/** §9: receipt state is independent of publication state. */
export const receiptStatus = pgEnum("receipt_status", [
  "pending",
  "submitted",
  "confirmed",
  "finalized",
  "failed",
  "unavailable",
]);

/* ------------------------------------------------------------------ */
/* subjects                                                             */
/* ------------------------------------------------------------------ */

export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Unique public slug; old slugs survive as redirect aliases (§4). */
    slug: text("slug").notNull().unique(),
    canonicalName: text("canonical_name").notNull(),
    /** All known names incl. former slugs; trigram-indexed for fuzzy lookup. */
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    kind: subjectKind("kind").notNull(),
    shortDescription: text("short_description"),
    /**
     * Approximate dates are stored as text ("2019", "2019-06"); never
     * manufacture a precise day from a year-only source (§4).
     */
    firstKnownDate: text("first_known_date"),
    datePrecision: datePrecision("date_precision"),
    officialUrls: text("official_urls").array().notNull().default(sql`'{}'::text[]`),
    visibility: subjectVisibility("visibility").notNull().default("hidden"),
    currentPublishedVersionId: uuid("current_published_version_id").references(
      (): AnyPgColumn => dossierVersions.id,
    ),
    /** GIN full-text over canonical name + description + aliases. */
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(
        sql`to_tsvector('english', coalesce(canonical_name, '') || ' ' || coalesce(short_description, '') || ' ' || coalesce(array_to_string(aliases, ' '), ''))`,
      ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("subjects_kind_idx").on(table.kind),
    index("subjects_visibility_idx").on(table.visibility),
    index("subjects_search_vector_gin_idx").using("gin", table.searchVector),
    // Optional trigram index for aliases (§4). gin_trgm_ops does not support
    // text[] directly, so index the space-joined string expression.
    index("subjects_aliases_trgm_idx").using(
      "gin",
      sql`array_to_string(${table.aliases}, ' ') gin_trgm_ops`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* subject_external_identifiers                                         */
/* ------------------------------------------------------------------ */

export const subjectExternalIdentifiers = pgTable(
  "subject_external_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    /** e.g. github_repo, npm_package, platform_id, chain_mint, domain. */
    idKind: text("id_kind").notNull(),
    identifier: text("identifier").notNull(),
    /** Alternate spellings/URLs for the same external identity. */
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("subject_external_identifiers_unique_idx").on(
      table.subjectId,
      table.idKind,
      table.identifier,
    ),
    index("subject_external_identifiers_subject_idx").on(table.subjectId),
    // Optional trigram index for aliases (§4). gin_trgm_ops does not support
    // text[] directly, so index the space-joined string expression.
    index("subject_external_identifiers_aliases_trgm_idx").using(
      "gin",
      sql`array_to_string(${table.aliases}, ' ') gin_trgm_ops`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* dossier_versions (immutable publication records)                     */
/* ------------------------------------------------------------------ */

export const dossierVersions = pgTable(
  "dossier_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id")
      .notNull()
      .references((): AnyPgColumn => subjects.id, { onDelete: "cascade" }),
    /** Sequential per subject; unique(subject_id, version_number). */
    versionNumber: integer("version_number").notNull(),
    publicationKind: publicationKind("publication_kind").notNull(),
    /** SHA-256 hex of the canonical JCS payload (ADR-0002). */
    publicPayloadHash: text("public_payload_hash").notNull(),
    /**
     * Hash chain: SHA-256 of vN-1's canonical bytes; the 32-byte zero string
     * ("00…00", 64 hex chars) for v1.
     */
    previousPayloadHash: text("previous_payload_hash").notNull(),
    /** Content-addressed storage key for the canonical bytes. */
    canonicalObjectKey: text("canonical_object_key").notNull().unique(),
    /** ADR-0002 normalization scheme version. */
    hashSchemaVersion: integer("hash_schema_version").notNull().default(1),
    lifecycleStatus: lifecycleStatus("lifecycle_status").notNull(),
    /** §5: every lifecycle status needs a reason. */
    statusReason: text("status_reason").notNull(),
    confidenceBand: confidenceBand("confidence_band"),
    confidenceReason: text("confidence_reason"),
    reviewedAt: tstz("reviewed_at"),
    reviewedBy: uuid("reviewed_by"),
    /** Fixed before hashing (ADR-0002); chain time lives on the receipt. */
    intendedPublishedAt: tstz("intended_published_at"),
    publishedAt: tstz("published_at"),
    /** Next scheduled review date (§5). */
    nextReviewAt: tstz("next_review_at"),
    publicationState: publicationState("publication_state")
      .notNull()
      .default("published"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("dossier_versions_subject_version_unique_idx").on(
      table.subjectId,
      table.versionNumber,
    ),
    // §4: publication date/status index.
    index("dossier_versions_publication_idx").on(
      table.publishedAt,
      table.publicationState,
      table.lifecycleStatus,
    ),
    index("dossier_versions_subject_idx").on(table.subjectId),
    check(
      "dossier_versions_version_number_positive",
      sql`version_number >= 1`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* dossier_drafts (editable working content, separate from immutable     */
/* published records)                                                   */
/* ------------------------------------------------------------------ */

export const dossierDrafts = pgTable(
  "dossier_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    basedOnVersionId: uuid("based_on_version_id").references(
      () => dossierVersions.id,
    ),
    structuredContent: jsonb("structured_content").notNull().default({}),
    editorialState: editorialState("editorial_state").notNull().default("draft"),
    /** Optimistic locking counter (§8). */
    rowVersion: integer("row_version").notNull().default(1),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("dossier_drafts_subject_idx").on(table.subjectId),
    index("dossier_drafts_editorial_state_idx").on(table.editorialState),
    check("dossier_drafts_row_version_positive", sql`row_version >= 1`),
  ],
);

/* ------------------------------------------------------------------ */
/* timeline_events                                                      */
/* ------------------------------------------------------------------ */

export const timelineEvents = pgTable(
  "timeline_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    containerKind: contentContainerKind("container_kind").notNull(),
    /** Draft id or version id; polymorphic (see enum comment). */
    containerId: uuid("container_id").notNull(),
    eventType: text("event_type").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    dateStart: text("date_start"),
    dateEnd: text("date_end"),
    datePrecision: datePrecision("date_precision"),
    sourceClaimIds: uuid("source_claim_ids").array().notNull().default(sql`'{}'::uuid[]`),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index("timeline_events_subject_idx").on(table.subjectId),
    index("timeline_events_container_idx").on(
      table.containerKind,
      table.containerId,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* sources + source_snapshots                                           */
/* ------------------------------------------------------------------ */

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalUrl: text("canonical_url").notNull(),
    /**
     * SHA-256 hex of the normalized canonical URL. The dedup key: two copies
     * of the same article must not count as two independent sources (§4).
     */
    urlDigest: text("url_digest").notNull().unique(),
    domain: text("domain"),
    publisher: text("publisher"),
    sourceType: sourceType("source_type").notNull().default("other"),
    firstSeenAt: tstz("first_seen_at").notNull().defaultNow(),
    fetchPolicy: text("fetch_policy"),
    licenceOrPermissionNote: text("licence_or_permission_note"),
    availability: sourceAvailability("availability").notNull().default("available"),
    /** Provenance / syndication relationship (§4). */
    syndicatedFromId: uuid("syndicated_from_id"),
    createdAt: createdAt(),
  },
  (table) => [
    index("sources_domain_idx").on(table.domain),
    index("sources_source_type_idx").on(table.sourceType),
    foreignKey({
      columns: [table.syndicatedFromId],
      foreignColumns: [table.id],
      name: "sources_syndicated_from_fk",
    }),
  ],
);

export const sourceSnapshots = pgTable(
  "source_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    fetchedAt: tstz("fetched_at").notNull().defaultNow(),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    rawDigest: text("raw_digest"),
    normalizedDigest: text("normalized_digest"),
    /** Private S3 object key — access-controlled, never in public output. */
    privateObjectKey: text("private_object_key"),
    publicExcerpt: text("public_excerpt"),
    parserVersion: text("parser_version"),
    availability: snapshotAvailability("availability"),
    finalUrl: text("final_url"),
    redirectHistory: jsonb("redirect_history"),
    permittedRetentionUntil: tstz("permitted_retention_until"),
    createdAt: createdAt(),
  },
  (table) => [
    index("source_snapshots_source_fetched_idx").on(table.sourceId, table.fetchedAt),
    index("source_snapshots_normalized_digest_idx").on(table.normalizedDigest),
  ],
);

/* ------------------------------------------------------------------ */
/* claims + claim_evidence                                              */
/* ------------------------------------------------------------------ */

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    containerKind: contentContainerKind("container_kind").notNull(),
    /** Draft id or version id; polymorphic (see enum comment). */
    containerId: uuid("container_id").notNull(),
    claimText: text("claim_text").notNull(),
    claimKind: claimKind("claim_kind").notNull(),
    reviewState: claimReviewState("review_state").notNull().default("pending"),
    reviewerNote: text("reviewer_note"),
    /** GIN full-text over claim text. */
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', coalesce(claim_text, ''))`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("claims_container_idx").on(table.containerKind, table.containerId),
    index("claims_subject_idx").on(table.subjectId),
    index("claims_review_state_idx").on(table.reviewState),
    index("claims_search_vector_gin_idx").using("gin", table.searchVector),
  ],
);

export const claimEvidence = pgTable(
  "claim_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    sourceSnapshotId: uuid("source_snapshot_id")
      .notNull()
      .references(() => sourceSnapshots.id),
    excerpt: text("excerpt"),
    /** Locator into the snapshot (char offsets / selector), nullable. */
    locator: text("locator"),
    relationship: evidenceRelationship("relationship").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("claim_evidence_claim_idx").on(table.claimId),
    index("claim_evidence_snapshot_idx").on(table.sourceSnapshotId),
  ],
);

/* ------------------------------------------------------------------ */
/* observations                                                         */
/* ------------------------------------------------------------------ */

export const observations = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    sourceSnapshotId: uuid("source_snapshot_id").references(
      () => sourceSnapshots.id,
    ),
    observedAt: tstz("observed_at").notNull(),
    /** Measurement window as an ISO-8601 interval literal, when applicable. */
    measurementWindow: text("measurement_window"),
    metricName: text("metric_name").notNull(),
    /**
     * Unknown values are NULL; collection failure is not zero (§4).
     * Non-monetary metric: fractional values allowed.
     */
    value: numeric("value", { precision: 38, scale: 10 }),
    unit: text("unit"),
    provider: text("provider"),
    collectionMethod: text("collection_method"),
    qualityFlag: qualityFlag("quality_flag").notNull().default("verified"),
    createdAt: createdAt(),
  },
  (table) => [
    // §4: observations(subject, metric, observed_at).
    index("observations_subject_metric_time_idx").on(
      table.subjectId,
      table.metricName,
      table.observedAt,
    ),
    index("observations_snapshot_idx").on(table.sourceSnapshotId),
  ],
);

/* ------------------------------------------------------------------ */
/* subject_relations                                                    */
/* ------------------------------------------------------------------ */

export const subjectRelations = pgTable(
  "subject_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromSubjectId: uuid("from_subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    toSubjectId: uuid("to_subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    relationshipType: relationshipType("relationship_type").notNull(),
    /** 0..1 calibrated confidence; evidence required (§4). */
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    supportingClaimId: uuid("supporting_claim_id").references(() => claims.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("subject_relations_unique_idx").on(
      table.fromSubjectId,
      table.toSubjectId,
      table.relationshipType,
    ),
    index("subject_relations_from_idx").on(table.fromSubjectId),
    index("subject_relations_to_idx").on(table.toSubjectId),
    check(
      "subject_relations_confidence_range",
      sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`,
    ),
    check(
      "subject_relations_no_self_link",
      sql`from_subject_id <> to_subject_id`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* publication_receipts (§9: receipt state independent of publication)  */
/* ------------------------------------------------------------------ */

export const publicationReceipts = pgTable(
  "publication_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * One receipt row per version. A retry must not create a different
     * receipt for the same version (§4) — enforced by this UNIQUE.
     */
    versionId: uuid("version_id")
      .notNull()
      .unique()
      .references(() => dossierVersions.id, { onDelete: "cascade" }),
    chain: text("chain").notNull().default("solana"),
    programId: text("program_id"),
    receiptAccount: text("receipt_account"),
    signature: text("signature"),
    slot: bigint("slot", { mode: "number" }),
    /** Chain timestamp, stored separately from intendedPublishedAt (ADR-0002). */
    blockTime: tstz("block_time"),
    status: receiptStatus("status").notNull().default("pending"),
    lastCheckedAt: tstz("last_checked_at"),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Reconciler scan: receipts that still need attention.
    index("publication_receipts_status_idx").on(table.status),
  ],
);

/* ------------------------------------------------------------------ */
