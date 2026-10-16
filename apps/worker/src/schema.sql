-- ============================================================================
-- AFTERBYTE worker — required table contract
-- ============================================================================
-- Owned by @afterbyte/database (database lane). This file documents the exact
-- table shapes the worker's PgStores implementation (src/pg.ts) issues SQL
-- against. Column names and semantics here are normative for the worker;
-- the database lane may add columns/indexes but must not rename or drop
-- these without coordinating with the worker lane.
--
-- Conventions: UUID PKs (gen_random_uuid()), timestamptz UTC, expand/backfill/
-- contract migrations only, never destructive on production (ADR-0003).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Outbox: domain mutation + event committed in ONE transaction (brief §8).
-- Dispatcher claims due `pending` rows with SELECT ... FOR UPDATE SKIP LOCKED.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','dispatched','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at   TIMESTAMPTZ,
  job_id          TEXT,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_events_due_idx
  ON outbox_events (status, next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_events_stuck_idx
  ON outbox_events (status, dispatched_at)
  WHERE status = 'dispatched';

-- Transactional consumer dedup for at-least-once delivery.
CREATE TABLE IF NOT EXISTS handled_events (
  event_id    UUID NOT NULL,
  consumer    TEXT NOT NULL,
  handled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

-- ----------------------------------------------------------------------------
-- Business-level job dedup. This table — NOT BullMQ job rows — is the durable
-- record of logical work. Queue job removal must never erase these rows.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_records (
  job_key      TEXT PRIMARY KEY,
  queue        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TIMESTAMPTZ,
  cancelled    BOOLEAN NOT NULL DEFAULT FALSE,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_records_stranded_idx
  ON job_records (status, heartbeat_at)
  WHERE status = 'running';

-- ----------------------------------------------------------------------------
-- Leases for long steps + worker heartbeats (brief §8).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_leases (
  lease_key    TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id  TEXT PRIMARY KEY,
  queues     TEXT[] NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stats      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ----------------------------------------------------------------------------
-- Read models (brief §14). Materialized from PUBLISHED data only.
-- The view/query feeding listPublishedSubjects MUST exclude rejected and
-- unpublished rows; the worker additionally filters defensively.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS read_models (
  key             TEXT PRIMARY KEY,
  payload         JSONB NOT NULL,
  as_of           TIMESTAMPTZ NOT NULL,
  source_revision TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Publication receipts + tx attempts (brief §10).
-- Tx attempts are persisted BEFORE submission — never after.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS publication_receipts (
  subject_id     TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  payload_hash   TEXT NOT NULL,
  publication_kind TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','submitted','confirmed','finalized','failed','unavailable')),
  signature      TEXT,
  slot           BIGINT,
  finalized_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, version_number)
);
CREATE INDEX IF NOT EXISTS publication_receipts_recheck_idx
  ON publication_receipts (status)
  WHERE status IN ('pending','submitted','confirmed');

CREATE TABLE IF NOT EXISTS tx_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id     TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  signature      TEXT NOT NULL,
  slot           BIGINT,
  status         TEXT NOT NULL
                   CHECK (status IN ('pending','submitted','confirmed','finalized','failed','unavailable')),
  rpc_url        TEXT NOT NULL,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tx_attempts_receipt_idx
  ON tx_attempts (subject_id, version_number, created_at DESC);

-- ----------------------------------------------------------------------------
-- Publication versions (written by the worker's publish flow in ONE
-- transaction together with the current-version pointer + outbox events).
-- The editorial lane owns drafts/review; the worker owns the immutable
-- version rows it commits.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dossier_versions (
  subject_id      TEXT NOT NULL,
  version_number  INTEGER NOT NULL,
  payload_hash    TEXT NOT NULL,
  object_key      TEXT NOT NULL,
  canonical_bytes BYTEA,              -- optional: DB copy; authority is object storage
  published_at    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, version_number)
);

CREATE TABLE IF NOT EXISTS dossier_current_versions (
  subject_id          TEXT PRIMARY KEY,
  current_version     INTEGER NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Public events (brief §14): replayable SSE log, 7-day retention.
-- Written by the outbox dispatcher; read by the API lane.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT NOT NULL,
  aggregate_id  TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS public_events_replay_idx
  ON public_events (occurred_at DESC, id DESC);

-- ----------------------------------------------------------------------------
-- Research pipeline state (worker-owned).
-- Mirrors packages/database's research tables; the worker lane owns this
-- schema until the two converge on the Drizzle client (see pg.ts header).
-- The research adapter (src/adapters/research.ts) is the only writer.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS research_runs (
  run_id            TEXT PRIMARY KEY,
  subject_name      TEXT NOT NULL,
  subject_kind      TEXT NOT NULL,
  aliases           JSONB NOT NULL DEFAULT '[]'::jsonb,
  known_urls        JSONB NOT NULL DEFAULT '[]'::jsonb,
  state             TEXT NOT NULL DEFAULT 'queued',
  caps              JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_calls_used  INTEGER NOT NULL DEFAULT 0,
  reserved_micros   BIGINT NOT NULL DEFAULT 0,
  spent_micros      BIGINT NOT NULL DEFAULT 0,
  steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_code      TEXT,
  failure_message   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_sources (
  source_id     TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES research_runs(run_id),
  provider_id   TEXT NOT NULL,
  candidate_id  TEXT NOT NULL,
  url           TEXT NOT NULL,
  final_url     TEXT,
  rationale     TEXT NOT NULL DEFAULT '',
  relevance     DOUBLE PRECISION NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'discovered',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_sources_run_idx ON research_sources(run_id);

CREATE TABLE IF NOT EXISTS research_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES research_runs(run_id),
  source_id     TEXT NOT NULL REFERENCES research_sources(source_id),
  provider_id   TEXT NOT NULL,
  original_url  TEXT NOT NULL,
  final_url     TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  content_type  TEXT,
  content_hash  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  truncated     BOOLEAN NOT NULL DEFAULT false,
  etag          TEXT,
  last_modified TEXT,
  storage_key   TEXT,
  excerpt       TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL,
  error_code    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_snapshots_run_idx ON research_snapshots(run_id);
CREATE INDEX IF NOT EXISTS research_snapshots_source_idx ON research_snapshots(source_id);

CREATE TABLE IF NOT EXISTS research_facts (
  fact_id        TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES research_runs(run_id),
  snapshot_id    TEXT NOT NULL REFERENCES research_snapshots(snapshot_id),
  fact_text      TEXT NOT NULL,
  claim_kind     TEXT NOT NULL,
  date_value     TEXT,
  date_precision TEXT,
  evidence_spans JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_facts_run_idx ON research_facts(run_id);

CREATE TABLE IF NOT EXISTS research_drafts (
  draft_id           TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES research_runs(run_id),
  sections           JSONB NOT NULL DEFAULT '[]'::jsonb,
  lifecycle_proposal JSONB,
  model_call_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT NOT NULL DEFAULT 'draft',
  preflight_report   JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
