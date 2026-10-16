-- AFTERBYTE initial schema (Lane 1: database).
-- pg_trgm is required for the trigram GIN indexes on aliases.
-- pgcrypto is required for gen_random_uuid() column defaults.
-- drizzle-kit does not emit CREATE EXTENSION, so they are prepended here by hand.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint

CREATE TYPE "public"."role" AS ENUM('admin', 'editor', 'reviewer', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."claim_kind" AS ENUM('sourced_fact', 'inference', 'disputed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."claim_review_state" AS ENUM('pending', 'accepted', 'disputed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."confidence_band" AS ENUM('strong', 'moderate', 'limited');--> statement-breakpoint
CREATE TYPE "public"."content_container_kind" AS ENUM('draft', 'version');--> statement-breakpoint
CREATE TYPE "public"."date_precision" AS ENUM('year', 'month', 'day', 'approximate');--> statement-breakpoint
CREATE TYPE "public"."editorial_state" AS ENUM('draft', 'researching', 'ready_for_review', 'approved', 'published');--> statement-breakpoint
CREATE TYPE "public"."evidence_relationship" AS ENUM('supports', 'contradicts');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_status" AS ENUM('active', 'dormant', 'discontinued', 'revived', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."publication_kind" AS ENUM('initial', 'update', 'correction', 'retraction_notice');--> statement-breakpoint
CREATE TYPE "public"."publication_state" AS ENUM('published', 'retracted');--> statement-breakpoint
CREATE TYPE "public"."quality_flag" AS ENUM('verified', 'estimated', 'suspect', 'collection_failed');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('pending', 'submitted', 'confirmed', 'finalized', 'failed', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."relationship_type" AS ENUM('successor', 'fork', 'inspired_by', 'revival_of', 'other');--> statement-breakpoint
CREATE TYPE "public"."snapshot_availability" AS ENUM('success', 'http_error', 'network_error', 'blocked', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."source_availability" AS ENUM('available', 'unavailable', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('official_site', 'rss_feed', 'github', 'wikipedia', 'archive', 'social', 'search_result', 'other');--> statement-breakpoint
CREATE TYPE "public"."subject_kind" AS ENUM('app', 'website', 'game', 'meme', 'community', 'crypto_project', 'other');--> statement-breakpoint
CREATE TYPE "public"."subject_visibility" AS ENUM('public', 'unlisted', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."event_visibility" AS ENUM('public', 'internal');--> statement-breakpoint
CREATE TYPE "public"."home_edition_state" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."outbox_event_state" AS ENUM('pending', 'dispatched', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."rights_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."contributor_award_state" AS ENUM('proposed', 'approved', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('USD');--> statement-breakpoint
CREATE TYPE "public"."investigation_order_state" AS ENUM('draft', 'pending_payment', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ledger_account" AS ENUM('cash', 'accounts_receivable', 'customer_obligation', 'recognized_revenue', 'refund_liability', 'reward_liability');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_state" AS ENUM('created', 'pending', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_state" AS ENUM('created', 'pending', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."refund_state" AS ENUM('requested', 'approved', 'processed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."moderation_state" AS ENUM('pending', 'approved', 'rejected', 'needs_info');--> statement-breakpoint
CREATE TYPE "public"."research_run_state" AS ENUM('queued', 'running', 'awaiting_provider', 'awaiting_review', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."research_step_state" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."validation_outcome" AS ENUM('valid', 'repaired', 'invalid');--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_identity_id" uuid,
	"user_id" uuid,
	"challenge" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenges_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"email" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "wallet_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"verified_at" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"source_snapshot_id" uuid NOT NULL,
	"excerpt" text,
	"locator" text,
	"relationship" "evidence_relationship" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"container_kind" "content_container_kind" NOT NULL,
	"container_id" uuid NOT NULL,
	"claim_text" text NOT NULL,
	"claim_kind" "claim_kind" NOT NULL,
	"review_state" "claim_review_state" DEFAULT 'pending' NOT NULL,
	"reviewer_note" text,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dossier_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"based_on_version_id" uuid,
	"structured_content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"editorial_state" "editorial_state" DEFAULT 'draft' NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dossier_drafts_row_version_positive" CHECK (row_version >= 1)
);
--> statement-breakpoint
CREATE TABLE "dossier_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"publication_kind" "publication_kind" NOT NULL,
	"public_payload_hash" text NOT NULL,
	"previous_payload_hash" text NOT NULL,
	"canonical_object_key" text NOT NULL,
	"hash_schema_version" integer DEFAULT 1 NOT NULL,
	"lifecycle_status" "lifecycle_status" NOT NULL,
	"status_reason" text NOT NULL,
	"confidence_band" "confidence_band",
	"confidence_reason" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"intended_published_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"next_review_at" timestamp with time zone,
	"publication_state" "publication_state" DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dossier_versions_canonical_object_key_unique" UNIQUE("canonical_object_key"),
	CONSTRAINT "dossier_versions_version_number_positive" CHECK (version_number >= 1)
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"source_snapshot_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"measurement_window" text,
	"metric_name" text NOT NULL,
	"value" numeric(38, 10),
	"unit" text,
	"provider" text,
	"collection_method" text,
	"quality_flag" "quality_flag" DEFAULT 'verified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"chain" text DEFAULT 'solana' NOT NULL,
	"program_id" text,
	"receipt_account" text,
	"signature" text,
	"slot" bigint,
	"block_time" timestamp with time zone,
	"status" "receipt_status" DEFAULT 'pending' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_receipts_version_id_unique" UNIQUE("version_id")
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"http_status" integer,
	"content_type" text,
	"raw_digest" text,
	"normalized_digest" text,
	"private_object_key" text,
	"public_excerpt" text,
	"parser_version" text,
	"availability" "snapshot_availability",
	"final_url" text,
	"redirect_history" jsonb,
	"permitted_retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_url" text NOT NULL,
	"url_digest" text NOT NULL,
	"domain" text,
	"publisher" text,
	"source_type" "source_type" DEFAULT 'other' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetch_policy" text,
	"licence_or_permission_note" text,
	"availability" "source_availability" DEFAULT 'available' NOT NULL,
	"syndicated_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_url_digest_unique" UNIQUE("url_digest")
);
--> statement-breakpoint
CREATE TABLE "subject_external_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"id_kind" text NOT NULL,
	"identifier" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_subject_id" uuid NOT NULL,
	"to_subject_id" uuid NOT NULL,
	"relationship_type" "relationship_type" NOT NULL,
	"confidence" numeric(5, 4),
	"supporting_claim_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_relations_confidence_range" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
	CONSTRAINT "subject_relations_no_self_link" CHECK (from_subject_id <> to_subject_id)
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"canonical_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"kind" "subject_kind" NOT NULL,
	"short_description" text,
	"first_known_date" text,
	"date_precision" date_precision,
	"official_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"visibility" "subject_visibility" DEFAULT 'hidden' NOT NULL,
	"current_published_version_id" uuid,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subjects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid NOT NULL,
	"container_kind" "content_container_kind" NOT NULL,
	"container_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"date_start" text,
	"date_end" text,
	"date_precision" date_precision,
	"source_claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "activity_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_revision" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visibility" "event_visibility" DEFAULT 'internal' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_url" text NOT NULL,
	"width" integer,
	"height" integer,
	"aspect_ratio" numeric(10, 6),
	"alt_text" text,
	"attribution" text,
	"rights_status" "rights_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "featured_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"home_edition_id" uuid NOT NULL,
	"subject_id" uuid,
	"asset_id" uuid,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "featured_items_position_positive" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "home_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_date" date NOT NULL,
	"title" text NOT NULL,
	"state" "home_edition_state" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "home_editions_edition_date_unique" UNIQUE("edition_date")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"visibility" "event_visibility" DEFAULT 'internal' NOT NULL,
	"state" "outbox_event_state" DEFAULT 'pending' NOT NULL,
	"delivery_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_delivery_key_unique" UNIQUE("delivery_key")
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contributor_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"currency" "currency" DEFAULT 'USD' NOT NULL,
	"reason" text NOT NULL,
	"state" "contributor_award_state" DEFAULT 'proposed' NOT NULL,
	"awarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contributor_awards_amount_positive" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "investigation_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid,
	"ordered_by" uuid NOT NULL,
	"title" text NOT NULL,
	"scope" text,
	"state" "investigation_order_state" DEFAULT 'draft' NOT NULL,
	"amount" numeric(38, 0) DEFAULT '0' NOT NULL,
	"currency" "currency" DEFAULT 'USD' NOT NULL,
	"payment_intent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investigation_orders_amount_nonnegative" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_group" uuid NOT NULL,
	"account" "ledger_account" NOT NULL,
	"debit" numeric(38, 0) DEFAULT '0' NOT NULL,
	"credit" numeric(38, 0) DEFAULT '0' NOT NULL,
	"currency" "currency" DEFAULT 'USD' NOT NULL,
	"reference_kind" text,
	"reference_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_single_sided" CHECK ((debit = 0 AND credit > 0) OR (credit = 0 AND debit > 0))
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"provider" text,
	"amount" numeric(38, 0) NOT NULL,
	"state" "payment_attempt_state" DEFAULT 'created' NOT NULL,
	"failure_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_attempts_amount_positive" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"currency" "currency" DEFAULT 'USD' NOT NULL,
	"state" "payment_intent_state" DEFAULT 'created' NOT NULL,
	"provider" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_amount_positive" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"reason" text,
	"state" "refund_state" DEFAULT 'requested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_positive" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "verified_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"signature" text NOT NULL,
	"instruction_locator" text NOT NULL,
	"amount" numeric(38, 0) NOT NULL,
	"mint" text,
	"sender" text,
	"recipient" text,
	"slot" bigint,
	"block_time" timestamp with time zone,
	"intent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verified_transfers_amount_positive" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"submitted_by" uuid,
	"correction_text" text NOT NULL,
	"moderation_state" "moderation_state" DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"resulting_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_template_version" text NOT NULL,
	"output_schema_version" text,
	"prompt_digest" text,
	"usage" jsonb,
	"validation_outcome" "validation_outcome" DEFAULT 'valid' NOT NULL,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_id" uuid,
	"trigger" text NOT NULL,
	"workflow_version" text NOT NULL,
	"state" "research_run_state" DEFAULT 'queued' NOT NULL,
	"stage" text,
	"budget_reserved" numeric(38, 0) DEFAULT '0' NOT NULL,
	"actual_cost" numeric(38, 0),
	"currency" text DEFAULT 'USD' NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_runs_budget_nonnegative" CHECK (budget_reserved >= 0)
);
--> statement-breakpoint
CREATE TABLE "research_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"name" text NOT NULL,
	"state" "research_step_state" DEFAULT 'pending' NOT NULL,
	"decision_summary" text,
	"output_ref" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_steps_step_number_positive" CHECK (step_number >= 1)
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submitter_id" uuid,
	"subject_id" uuid,
	"supplied_evidence_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text NOT NULL,
	"moderation_state" "moderation_state" DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_wallet_identity_id_wallet_identities_id_fk" FOREIGN KEY ("wallet_identity_id") REFERENCES "public"."wallet_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_identities" ADD CONSTRAINT "wallet_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_source_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_drafts" ADD CONSTRAINT "dossier_drafts_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_drafts" ADD CONSTRAINT "dossier_drafts_based_on_version_id_dossier_versions_id_fk" FOREIGN KEY ("based_on_version_id") REFERENCES "public"."dossier_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dossier_versions" ADD CONSTRAINT "dossier_versions_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_source_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_receipts" ADD CONSTRAINT "publication_receipts_version_id_dossier_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dossier_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_syndicated_from_fk" FOREIGN KEY ("syndicated_from_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_external_identifiers" ADD CONSTRAINT "subject_external_identifiers_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_relations" ADD CONSTRAINT "subject_relations_from_subject_id_subjects_id_fk" FOREIGN KEY ("from_subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_relations" ADD CONSTRAINT "subject_relations_to_subject_id_subjects_id_fk" FOREIGN KEY ("to_subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_relations" ADD CONSTRAINT "subject_relations_supporting_claim_id_claims_id_fk" FOREIGN KEY ("supporting_claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_current_published_version_id_dossier_versions_id_fk" FOREIGN KEY ("current_published_version_id") REFERENCES "public"."dossier_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_items" ADD CONSTRAINT "featured_items_home_edition_id_home_editions_id_fk" FOREIGN KEY ("home_edition_id") REFERENCES "public"."home_editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_items" ADD CONSTRAINT "featured_items_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "featured_items" ADD CONSTRAINT "featured_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlist_id_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributor_awards" ADD CONSTRAINT "contributor_awards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_orders" ADD CONSTRAINT "investigation_orders_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_orders" ADD CONSTRAINT "investigation_orders_ordered_by_users_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_orders" ADD CONSTRAINT "investigation_orders_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_transfers" ADD CONSTRAINT "verified_transfers_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_version_id_dossier_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dossier_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_resulting_version_id_dossier_versions_id_fk" FOREIGN KEY ("resulting_version_id") REFERENCES "public"."dossier_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_step_id_research_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."research_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_steps" ADD CONSTRAINT "research_steps_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitter_id_users_id_fk" FOREIGN KEY ("submitter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_grants_active_unique_idx" ON "role_grants" USING btree ("user_id","role") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "role_grants_user_idx" ON "role_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_identities_chain_address_unique_idx" ON "wallet_identities" USING btree ("chain","address");--> statement-breakpoint
CREATE INDEX "wallet_identities_address_idx" ON "wallet_identities" USING btree ("address");--> statement-breakpoint
CREATE INDEX "wallet_identities_user_idx" ON "wallet_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_claim_idx" ON "claim_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_snapshot_idx" ON "claim_evidence" USING btree ("source_snapshot_id");--> statement-breakpoint
CREATE INDEX "claims_container_idx" ON "claims" USING btree ("container_kind","container_id");--> statement-breakpoint
CREATE INDEX "claims_subject_idx" ON "claims" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "claims_review_state_idx" ON "claims" USING btree ("review_state");--> statement-breakpoint
CREATE INDEX "claims_search_vector_gin_idx" ON "claims" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "dossier_drafts_subject_idx" ON "dossier_drafts" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "dossier_drafts_editorial_state_idx" ON "dossier_drafts" USING btree ("editorial_state");--> statement-breakpoint
CREATE UNIQUE INDEX "dossier_versions_subject_version_unique_idx" ON "dossier_versions" USING btree ("subject_id","version_number");--> statement-breakpoint
CREATE INDEX "dossier_versions_publication_idx" ON "dossier_versions" USING btree ("published_at","publication_state","lifecycle_status");--> statement-breakpoint
CREATE INDEX "dossier_versions_subject_idx" ON "dossier_versions" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "observations_subject_metric_time_idx" ON "observations" USING btree ("subject_id","metric_name","observed_at");--> statement-breakpoint
CREATE INDEX "observations_snapshot_idx" ON "observations" USING btree ("source_snapshot_id");--> statement-breakpoint
CREATE INDEX "publication_receipts_status_idx" ON "publication_receipts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "source_snapshots_source_fetched_idx" ON "source_snapshots" USING btree ("source_id","fetched_at");--> statement-breakpoint
CREATE INDEX "source_snapshots_normalized_digest_idx" ON "source_snapshots" USING btree ("normalized_digest");--> statement-breakpoint
CREATE INDEX "sources_domain_idx" ON "sources" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "sources_source_type_idx" ON "sources" USING btree ("source_type");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_external_identifiers_unique_idx" ON "subject_external_identifiers" USING btree ("subject_id","id_kind","identifier");--> statement-breakpoint
CREATE INDEX "subject_external_identifiers_subject_idx" ON "subject_external_identifiers" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subject_relations_unique_idx" ON "subject_relations" USING btree ("from_subject_id","to_subject_id","relationship_type");--> statement-breakpoint
CREATE INDEX "subject_relations_from_idx" ON "subject_relations" USING btree ("from_subject_id");--> statement-breakpoint
CREATE INDEX "subject_relations_to_idx" ON "subject_relations" USING btree ("to_subject_id");--> statement-breakpoint
CREATE INDEX "subjects_kind_idx" ON "subjects" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "subjects_visibility_idx" ON "subjects" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "subjects_search_vector_gin_idx" ON "subjects" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "timeline_events_subject_idx" ON "timeline_events" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "timeline_events_container_idx" ON "timeline_events" USING btree ("container_kind","container_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_sequence_unique_idx" ON "activity_events" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "activity_events_aggregate_idx" ON "activity_events" USING btree ("aggregate_id","aggregate_revision");--> statement-breakpoint
CREATE INDEX "activity_events_visibility_occurred_idx" ON "activity_events" USING btree ("visibility","occurred_at");--> statement-breakpoint
CREATE INDEX "assets_rights_status_idx" ON "assets" USING btree ("rights_status");--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_user_subject_unique_idx" ON "bookmarks" USING btree ("user_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "featured_items_edition_position_unique_idx" ON "featured_items" USING btree ("home_edition_id","position");--> statement-breakpoint
CREATE INDEX "home_editions_state_idx" ON "home_editions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_delivery_idx" ON "outbox_events" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_items_unique_idx" ON "watchlist_items" USING btree ("watchlist_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlists_user_name_unique_idx" ON "watchlists" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "contributor_awards_user_idx" ON "contributor_awards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "contributor_awards_state_idx" ON "contributor_awards" USING btree ("state");--> statement-breakpoint
CREATE INDEX "investigation_orders_ordered_by_idx" ON "investigation_orders" USING btree ("ordered_by");--> statement-breakpoint
CREATE INDEX "investigation_orders_state_idx" ON "investigation_orders" USING btree ("state");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_group_idx" ON "ledger_entries" USING btree ("journal_group");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_created_idx" ON "ledger_entries" USING btree ("account","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_intent_idx" ON "payment_attempts" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "payment_intents_user_idx" ON "payment_intents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payment_intents_state_idx" ON "payment_intents" USING btree ("state");--> statement-breakpoint
CREATE INDEX "refunds_intent_idx" ON "refunds" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "refunds_state_idx" ON "refunds" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_transfers_chain_sig_locator_unique_idx" ON "verified_transfers" USING btree ("chain","signature","instruction_locator");--> statement-breakpoint
CREATE INDEX "verified_transfers_intent_idx" ON "verified_transfers" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "corrections_version_idx" ON "corrections" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "corrections_moderation_state_idx" ON "corrections" USING btree ("moderation_state");--> statement-breakpoint
CREATE INDEX "model_calls_run_idx" ON "model_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "model_calls_step_idx" ON "model_calls" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "research_runs_pending_idx" ON "research_runs" USING btree ("state","heartbeat_at") WHERE state IN ('queued', 'running', 'awaiting_provider', 'awaiting_review');--> statement-breakpoint
CREATE INDEX "research_runs_subject_idx" ON "research_runs" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_steps_run_step_unique_idx" ON "research_steps" USING btree ("run_id","step_number");--> statement-breakpoint
CREATE INDEX "submissions_moderation_state_idx" ON "submissions" USING btree ("moderation_state");--> statement-breakpoint
CREATE INDEX "submissions_subject_idx" ON "submissions" USING btree ("subject_id");