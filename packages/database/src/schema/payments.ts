import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { subjects } from "./core.js";
import { createdAt, money, tstz, updatedAt } from "./_common.js";

/* ------------------------------------------------------------------ */
/* Release B interfaces behind feature flags (ADR-0003).                 */
/* PAYMENTS_ENABLED=false default. No payment CTA may exist before the   */
/* settlement path is verified; no token, no ticker, no tokenomics.      */
/*                                                                     */
/* Money rule (brief §4): integer base units as decimal strings in      */
/* JSON; numeric(38,0) columns; never floating-point money.             */
/* ------------------------------------------------------------------ */

export const currency = pgEnum("currency", ["USD"]);

export const investigationOrderState = pgEnum("investigation_order_state", [
  "draft",
  "pending_payment",
  "active",
  "completed",
  "cancelled",
]);

export const paymentIntentState = pgEnum("payment_intent_state", [
  "created",
  "pending",
  "succeeded",
  "failed",
  "cancelled",
]);

export const paymentAttemptState = pgEnum("payment_attempt_state", [
  "created",
  "pending",
  "succeeded",
  "failed",
  "cancelled",
]);

export const refundState = pgEnum("refund_state", [
  "requested",
  "approved",
  "processed",
  "failed",
  "cancelled",
]);

export const contributorAwardState = pgEnum("contributor_award_state", [
  "proposed",
  "approved",
  "paid",
  "cancelled",
]);

/**
 * §4: balanced accounting journal for receivables, customer obligations,
 * recognised revenue, refunds and reward liabilities. Treasury balances and
 * research revenue are different concepts — separate accounts below.
 */
export const ledgerAccount = pgEnum("ledger_account", [
  "cash",
  "accounts_receivable",
  "customer_obligation",
  "recognized_revenue",
  "refund_liability",
  "reward_liability",
]);

/* ------------------------------------------------------------------ */
/* investigation_orders (paid research requests; Release B)              */
/* ------------------------------------------------------------------ */

export const investigationOrders = pgTable(
  "investigation_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    orderedBy: uuid("ordered_by")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    scope: text("scope"),
    state: investigationOrderState("state").notNull().default("draft"),
    amount: money("amount").notNull().default("0"),
    currency: currency("currency").notNull().default("USD"),
    paymentIntentId: uuid("payment_intent_id").references(
      () => paymentIntents.id,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("investigation_orders_ordered_by_idx").on(table.orderedBy),
    index("investigation_orders_state_idx").on(table.state),
    check("investigation_orders_amount_nonnegative", sql`amount >= 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* payment_intents                                                       */
/* ------------------------------------------------------------------ */

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    purpose: text("purpose").notNull(),
    amount: money("amount").notNull(),
    currency: currency("currency").notNull().default("USD"),
    state: paymentIntentState("state").notNull().default("created"),
    /** Settlement provider id, e.g. solana_usdc (Release B only). */
    provider: text("provider"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("payment_intents_user_idx").on(table.userId),
    index("payment_intents_state_idx").on(table.state),
    check("payment_intents_amount_positive", sql`amount > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* payment_attempts (§8: financial retry logic is stricter — determine   */
/* whether the earlier transfer settled before building another one)     */
/* ------------------------------------------------------------------ */

export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => paymentIntents.id, { onDelete: "cascade" }),
    provider: text("provider"),
    amount: money("amount").notNull(),
    state: paymentAttemptState("state").notNull().default("created"),
    failureCode: text("failure_code"),
    /** Provider-side idempotency key; never retry blindly without it. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: createdAt(),
  },
  (table) => [
    index("payment_attempts_intent_idx").on(table.intentId),
    check("payment_attempts_amount_positive", sql`amount > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* verified_transfers (§4: unique(chain, signature, instruction_locator) */
/* on credited transfers — DB-level replay protection)                  */
/* ------------------------------------------------------------------ */

export const verifiedTransfers = pgTable(
  "verified_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chain: text("chain").notNull(),
    /** Transaction signature as the chain reports it. */
    signature: text("signature").notNull(),
    /** Position of the credited instruction within the transaction. */
    instructionLocator: text("instruction_locator").notNull(),
    amount: money("amount").notNull(),
    /** Mint/asset identifier, e.g. USDC mint address. */
    mint: text("mint"),
    sender: text("sender"),
    recipient: text("recipient"),
    slot: bigint("slot", { mode: "number" }),
    blockTime: tstz("block_time"),
    intentId: uuid("intent_id").references(() => paymentIntents.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("verified_transfers_chain_sig_locator_unique_idx").on(
      table.chain,
      table.signature,
      table.instructionLocator,
    ),
    index("verified_transfers_intent_idx").on(table.intentId),
    check("verified_transfers_amount_positive", sql`amount > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* refunds                                                               */
/* ------------------------------------------------------------------ */

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    amount: money("amount").notNull(),
    reason: text("reason"),
    state: refundState("state").notNull().default("requested"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("refunds_intent_idx").on(table.intentId),
    index("refunds_state_idx").on(table.state),
    check("refunds_amount_positive", sql`amount > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* contributor_awards (reward liabilities; Release B)                    */
/* ------------------------------------------------------------------ */

export const contributorAwards = pgTable(
  "contributor_awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    amount: money("amount").notNull(),
    currency: currency("currency").notNull().default("USD"),
    reason: text("reason").notNull(),
    state: contributorAwardState("state").notNull().default("proposed"),
    awardedAt: tstz("awarded_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("contributor_awards_user_idx").on(table.userId),
    index("contributor_awards_state_idx").on(table.state),
    check("contributor_awards_amount_positive", sql`amount > 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* ledger_entries (§4: balanced journal; every journal_group must net    */
/* to zero — enforced by the accounting service, structurally aided     */
/* here by debit/credit discipline)                                     */
/* ------------------------------------------------------------------ */

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Groups the entries of one balanced journal posting. */
    journalGroup: uuid("journal_group").notNull(),
    account: ledgerAccount("account").notNull(),
    debit: money("debit").notNull().default("0"),
    credit: money("credit").notNull().default("0"),
    currency: currency("currency").notNull().default("USD"),
    /** What this entry settles, e.g. payment_intent / refund / award. */
    referenceKind: text("reference_kind"),
    referenceId: uuid("reference_id"),
    description: text("description"),
    createdAt: createdAt(),
  },
  (table) => [
    index("ledger_entries_journal_group_idx").on(table.journalGroup),
    index("ledger_entries_account_created_idx").on(table.account, table.createdAt),
    // Double-entry discipline: exactly one side is nonzero and non-negative.
    check(
      "ledger_entries_single_sided",
      sql`(debit = 0 AND credit > 0) OR (credit = 0 AND debit > 0)`,
    ),
  ],
);
