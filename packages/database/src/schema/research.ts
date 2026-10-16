import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { createdAt, money, moneyNullable, tstz, updatedAt } from "./_common.js";
import { dossierVersions, subjects } from "./core.js";

/* ------------------------------------------------------------------ */
/* Enums                                                                */
/* ------------------------------------------------------------------ */

/** §5: research run state. */
export const researchRunState = pgEnum("research_run_state", [
  "queued",
  "running",
  "awaiting_provider",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
]);

export const researchStepState = pgEnum("research_step_state", [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

/** §7: at most two repair attempts for malformed model output. */
export const validationOutcome = pgEnum("validation_outcome", [
  "valid",
  "repaired",
  "invalid",
]);

/** Submissions/corrections moderation state (§4). */
export const moderationState = pgEnum("moderation_state", [
  "pending",
  "approved",
  "rejected",
  "needs_info",
]);

/* ------------------------------------------------------------------ */
/* research_runs (§§7–8: bounded, budgeted, resumable runs)              */
/* ------------------------------------------------------------------ */

export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nullable: discovery runs may precede subject creation (§7 step 1). */
    subjectId: uuid("subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    /** e.g. scheduled, manual, correction, revisit. */
    trigger: text("trigger").notNull(),
    workflowVersion: text("workflow_version").notNull(),
    state: researchRunState("state").notNull().default("queued"),
    /** Current pipeline stage, e.g. discover / fetch / extract / draft. */
    stage: text("stage"),
    /** Reserved budget in integer base units (string at the JSON boundary). */
    budgetReserved: money("budget_reserved").notNull().default("0"),
    actualCost: moneyNullable("actual_cost"),
    currency: text("currency").notNull().default("USD"),
    startedAt: tstz("started_at"),
    /** §8: heartbeat for long steps; reconciler revives stranded runs. */
    heartbeatAt: tstz("heartbeat_at"),
    completedAt: tstz("completed_at"),
    errorCode: text("error_code"),
    /** §8: lease owner for crash recovery. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: tstz("lease_expires_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // §4: "pending jobs" index for the scheduler.
    index("research_runs_pending_idx")
      .on(table.state, table.heartbeatAt)
      .where(
        sql`state IN ('queued', 'running', 'awaiting_provider', 'awaiting_review')`,
      ),
    index("research_runs_subject_idx").on(table.subjectId),
    check("research_runs_budget_nonnegative", sql`budget_reserved >= 0`),
  ],
);

/* ------------------------------------------------------------------ */
/* research_steps (§7: observable steps, decision summaries only —       */
/* never hidden chain-of-thought)                                       */
/* ------------------------------------------------------------------ */

export const researchSteps = pgTable(
  "research_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number").notNull(),
    name: text("name").notNull(),
    state: researchStepState("state").notNull().default("pending"),
    /** Concise decision summary; no hidden chain-of-thought (§4). */
    decisionSummary: text("decision_summary"),
    /** Pointer to persisted step output (e.g. storage object key). */
    outputRef: text("output_ref"),
    startedAt: tstz("started_at"),
    completedAt: tstz("completed_at"),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("research_steps_run_step_unique_idx").on(
      table.runId,
      table.stepNumber,
    ),
    check("research_steps_step_number_positive", sql`step_number >= 1`),
  ],
);

/* ------------------------------------------------------------------ */
/* model_calls (§7: model/provider/template/output-schema versions,      */
/* usage and validation outcomes)                                       */
/* ------------------------------------------------------------------ */

export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => researchSteps.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    outputSchemaVersion: text("output_schema_version"),
    /** Digest of the rendered prompt (prompts live in versioned templates). */
    promptDigest: text("prompt_digest"),
    /** Token usage and cost; cost as integer base-unit strings. */
    usage: jsonb("usage"),
    validationOutcome: validationOutcome("validation_outcome")
      .notNull()
      .default("valid"),
    sourceIds: uuid("source_ids").array().notNull().default(sql`'{}'::uuid[]`),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (table) => [
    index("model_calls_run_idx").on(table.runId),
    index("model_calls_step_idx").on(table.stepId),
  ],
);

/* ------------------------------------------------------------------ */
/* submissions (§4: never expose private submitter info publicly)        */
/* ------------------------------------------------------------------ */

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nullable: anonymous submissions allowed; keep PII out of feeds. */
    submitterId: uuid("submitter_id").references(() => users.id, {
      onDelete: "set null",
    }),
    subjectId: uuid("subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    suppliedEvidenceUrls: text("supplied_evidence_urls")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reason: text("reason").notNull(),
    moderationState: moderationState("moderation_state")
      .notNull()
      .default("pending"),
    resolution: text("resolution"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: tstz("resolved_at"),
  },
  (table) => [
    index("submissions_moderation_state_idx").on(table.moderationState),
    index("submissions_subject_idx").on(table.subjectId),
  ],
);

/* ------------------------------------------------------------------ */
/* corrections (retractions/corrections produce a new version, §5)       */
/* ------------------------------------------------------------------ */

export const corrections = pgTable(
  "corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => dossierVersions.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    submittedBy: uuid("submitted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    correctionText: text("correction_text").notNull(),
    moderationState: moderationState("moderation_state")
      .notNull()
      .default("pending"),
    resolution: text("resolution"),
    /** The new published version incorporating the correction, if any. */
    resultingVersionId: uuid("resulting_version_id").references(
      () => dossierVersions.id,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: tstz("resolved_at"),
  },
  (table) => [
    index("corrections_version_idx").on(table.versionId),
    index("corrections_moderation_state_idx").on(table.moderationState),
  ],
);
