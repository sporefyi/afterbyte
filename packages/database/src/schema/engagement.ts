import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
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

import { users } from "./auth.js";
import { createdAt, tstz } from "./_common.js";
import { subjects } from "./core.js";

/* ------------------------------------------------------------------ */
/* Enums                                                                */
/* ------------------------------------------------------------------ */

/** Activity/outbox visibility: public feed vs internal operations (§4). */
export const eventVisibility = pgEnum("event_visibility", [
  "public",
  "internal",
]);

/** §8: outbox states; the dispatcher may deliver twice. */
export const outboxEventState = pgEnum("outbox_event_state", [
  "pending",
  "dispatched",
  "delivered",
  "failed",
]);

export const homeEditionState = pgEnum("home_edition_state", [
  "draft",
  "published",
]);

/** §4: only approved assets enter public responses. */
export const rightsStatus = pgEnum("rights_status", [
  "pending",
  "approved",
  "rejected",
]);

/* ------------------------------------------------------------------ */
/* assets (§4: media metadata; rights-gated)                             */
/* ------------------------------------------------------------------ */

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicUrl: text("public_url").notNull(),
    width: integer("width"),
    height: integer("height"),
    aspectRatio: numeric("aspect_ratio", { precision: 10, scale: 6 }),
    altText: text("alt_text"),
    attribution: text("attribution"),
    rightsStatus: rightsStatus("rights_status").notNull().default("pending"),
    approvedBy: uuid("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [index("assets_rights_status_idx").on(table.rightsStatus)],
);

/* ------------------------------------------------------------------ */
/* bookmarks (§4: unique(user_id, subject_id))                           */
/* ------------------------------------------------------------------ */

export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("bookmarks_user_subject_unique_idx").on(
      table.userId,
      table.subjectId,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* watchlists                                                           */
/* ------------------------------------------------------------------ */

export const watchlists = pgTable(
  "watchlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("watchlists_user_name_unique_idx").on(table.userId, table.name),
  ],
);

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    addedAt: tstz("added_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("watchlist_items_unique_idx").on(
      table.watchlistId,
      table.subjectId,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* notifications (§4: in-app for the initial release)                   */
/* ------------------------------------------------------------------ */

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Open text type; new kinds must not break old clients. */
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    payload: jsonb("payload").notNull().default({}),
    readAt: tstz("read_at"),
    createdAt: createdAt(),
  },
  (table) => [index("notifications_user_created_idx").on(table.userId, table.createdAt)],
);

/* ------------------------------------------------------------------ */
/* home_editions + featured_items (§4: editorial homepage composition)  */
/* ------------------------------------------------------------------ */

export const homeEditions = pgTable(
  "home_editions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    editionDate: date("edition_date").notNull().unique(),
    title: text("title").notNull(),
    state: homeEditionState("state").notNull().default("draft"),
    publishedAt: tstz("published_at"),
    createdAt: createdAt(),
  },
  (table) => [index("home_editions_state_idx").on(table.state)],
);

export const featuredItems = pgTable(
  "featured_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    homeEditionId: uuid("home_edition_id")
      .notNull()
      .references(() => homeEditions.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    assetId: uuid("asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("featured_items_edition_position_unique_idx").on(
      table.homeEditionId,
      table.position,
    ),
    check("featured_items_position_positive", sql`position >= 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* activity_events (§4: durable event IDs; public activity is a          */
/* sanitized projection, not a raw operational log)                     */
/* ------------------------------------------------------------------ */

export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Monotonic per-table sequence for cursor pagination and ordering.
     * §4 index: activity(sequence_id).
     */
    sequence: bigint("sequence", { mode: "number" })
      .notNull()
      .generatedAlwaysAsIdentity(),
    eventType: text("event_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateRevision: integer("aggregate_revision").notNull(),
    occurredAt: tstz("occurred_at").notNull().defaultNow(),
    visibility: eventVisibility("visibility").notNull().default("internal"),
    /** Approved/sanitized payload only — never raw operational detail. */
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("activity_events_sequence_unique_idx").on(table.sequence),
    index("activity_events_aggregate_idx").on(
      table.aggregateId,
      table.aggregateRevision,
    ),
    index("activity_events_visibility_occurred_idx").on(
      table.visibility,
      table.occurredAt,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* outbox_events (§8: domain mutation + outbox event in ONE transaction) */
/* ------------------------------------------------------------------ */

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateRevision: integer("aggregate_revision").notNull(),
    payload: jsonb("payload").notNull(),
    visibility: eventVisibility("visibility").notNull().default("internal"),
    state: outboxEventState("state").notNull().default("pending"),
    /**
     * Business-level idempotency key (e.g. `receipt-requested:<version_id>`).
     * The UNIQUE constraint — not Redis — enforces at-most-once business
     * effects when the dispatcher delivers twice (§4, §8).
     */
    deliveryKey: text("delivery_key").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    dispatchedAt: tstz("dispatched_at"),
    createdAt: createdAt(),
  },
  (table) => [
    // §4: "outbox delivery" index for the dispatcher scan.
    index("outbox_events_delivery_idx").on(table.state, table.nextAttemptAt),
    index("outbox_events_aggregate_idx").on(table.aggregateId),
  ],
);
