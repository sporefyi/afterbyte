import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, tstz, updatedAt } from "./_common.js";

/* ------------------------------------------------------------------ */
/* Enums                                                                */
/* ------------------------------------------------------------------ */

export const userStatus = pgEnum("user_status", [
  "active",
  "suspended",
  "deleted",
]);

/** §4: a wallet is not automatically an editor — roles are explicit grants. */
export const role = pgEnum("role", ["admin", "editor", "reviewer", "viewer"]);

/* ------------------------------------------------------------------ */
/* users                                                                */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name"),
    /** Nullable: wallet-only accounts may have no email. */
    email: text("email").unique(),
    status: userStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("users_status_idx").on(table.status)],
);

/* ------------------------------------------------------------------ */
/* wallet_identities (§4: wallet sign-in enables personal actions only)  */
/* ------------------------------------------------------------------ */

export const walletIdentities = pgTable(
  "wallet_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** e.g. solana. */
    chain: text("chain").notNull(),
    /** Base58 address; matched case-sensitively as stored. */
    address: text("address").notNull(),
    verifiedAt: tstz("verified_at"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    // One identity per chain+address across all users.
    uniqueIndex("wallet_identities_chain_address_unique_idx").on(
      table.chain,
      table.address,
    ),
    // §4: wallet address index.
    index("wallet_identities_address_idx").on(table.address),
    index("wallet_identities_user_idx").on(table.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* sessions (§4: hash session tokens at rest)                            */
/* ------------------------------------------------------------------ */

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the opaque session token; the raw token is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    expiresAt: tstz("expires_at").notNull(),
    revokedAt: tstz("revoked_at"),
    lastSeenAt: tstz("last_seen_at"),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/* ------------------------------------------------------------------ */
/* auth_challenges (wallet sign-in challenge/response)                   */
/* ------------------------------------------------------------------ */

export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletIdentityId: uuid("wallet_identity_id").references(
      () => walletIdentities.id,
      { onDelete: "cascade" },
    ),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Human-readable challenge text the wallet signs. */
    challenge: text("challenge").notNull(),
    nonce: text("nonce").notNull().unique(),
    expiresAt: tstz("expires_at").notNull(),
    consumedAt: tstz("consumed_at"),
    createdAt: createdAt(),
  },
  (table) => [index("auth_challenges_expires_idx").on(table.expiresAt)],
);

/* ------------------------------------------------------------------ */
/* role_grants (explicit authorization; never implicit from wallet)      */
/* ------------------------------------------------------------------ */

export const roleGrants = pgTable(
  "role_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: role("role").notNull(),
    grantedBy: uuid("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    grantedAt: tstz("granted_at").notNull().defaultNow(),
    revokedAt: tstz("revoked_at"),
  },
  (table) => [
    // A user holds at most one ACTIVE grant per role; history is preserved
    // via revoked_at rows.
    uniqueIndex("role_grants_active_unique_idx")
      .on(table.userId, table.role)
      .where(sql`revoked_at IS NULL`),
    index("role_grants_user_idx").on(table.userId),
  ],
);
