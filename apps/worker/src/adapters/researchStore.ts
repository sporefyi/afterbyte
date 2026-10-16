/**
 * Worker-owned research pipeline persistence.
 *
 * Tables live in src/schema.sql (research_runs, research_sources,
 * research_snapshots, research_facts, research_drafts) and mirror
 * packages/database's research tables; the worker lane owns this schema
 * until the two converge on the Drizzle client.
 *
 * The research adapter (research.ts) is the only writer. All methods take
 * an explicit pg Pool and are safe to call repeatedly (INSERT ... ON
 * CONFLICT DO NOTHING on natural keys) so retried jobs stay idempotent.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

export interface ResearchRunRow {
  runId: string;
  subjectName: string;
  subjectKind: string;
  aliases: string[];
  knownUrls: string[];
  state: string;
  caps: Record<string, unknown>;
  modelCallsUsed: number;
  reservedMicros: number;
  spentMicros: number;
  steps: unknown[];
  failureCode: string | null;
  failureMessage: string | null;
}

export interface ResearchSourceRow {
  sourceId: string;
  runId: string;
  providerId: string;
  candidateId: string;
  url: string;
  finalUrl: string | null;
  rationale: string;
  relevance: number;
  status: string;
}

export interface ResearchSnapshotRow {
  snapshotId: string;
  runId: string;
  sourceId: string;
  providerId: string;
  originalUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string | null;
  contentHash: string;
  bytes: number;
  truncated: boolean;
  etag: string | null;
  lastModified: string | null;
  storageKey: string | null;
  excerpt: string | null;
  fetchedAt: string;
  errorCode: string | null;
}

export interface ResearchFactRow {
  factId: string;
  runId: string;
  snapshotId: string;
  factText: string;
  claimKind: string;
  dateValue: string | null;
  datePrecision: string | null;
  evidenceSpans: unknown[];
}

export interface ResearchDraftRow {
  draftId: string;
  runId: string;
  sections: unknown[];
  lifecycleProposal: unknown;
  modelCallIds: string[];
  status: string;
  preflightReport: unknown;
}

function toRunRow(r: Record<string, unknown>): ResearchRunRow {
  return {
    runId: r.run_id as string,
    subjectName: r.subject_name as string,
    subjectKind: r.subject_kind as string,
    aliases: (r.aliases as string[]) ?? [],
    knownUrls: (r.known_urls as string[]) ?? [],
    state: r.state as string,
    caps: (r.caps as Record<string, unknown>) ?? {},
    modelCallsUsed: Number(r.model_calls_used ?? 0),
    reservedMicros: Number(r.reserved_micros ?? 0),
    spentMicros: Number(r.spent_micros ?? 0),
    steps: (r.steps as unknown[]) ?? [],
    failureCode: (r.failure_code as string) ?? null,
    failureMessage: (r.failure_message as string) ?? null,
  };
}

export class ResearchStore {
  constructor(private readonly pool: Pool) {}

  async getRun(runId: string): Promise<ResearchRunRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM research_runs WHERE run_id = $1', [runId]);
    return rows.length > 0 ? toRunRow(rows[0] as Record<string, unknown>) : null;
  }

  async createRun(input: {
    runId?: string;
    subjectName: string;
    subjectKind: string;
    aliases?: string[];
    knownUrls?: string[];
    caps?: Record<string, unknown>;
  }): Promise<ResearchRunRow> {
    const runId = input.runId ?? `run_${randomUUID()}`;
    const { rows } = await this.pool.query(
      `INSERT INTO research_runs (run_id, subject_name, subject_kind, aliases, known_urls, state, caps)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'queued', $6::jsonb)
       ON CONFLICT (run_id) DO NOTHING
       RETURNING *`,
      [
        runId,
        input.subjectName,
        input.subjectKind,
        JSON.stringify(input.aliases ?? []),
        JSON.stringify(input.knownUrls ?? []),
        JSON.stringify(input.caps ?? {}),
      ],
    );
    if (rows.length > 0) return toRunRow(rows[0] as Record<string, unknown>);
    const existing = await this.getRun(runId);
    if (!existing) throw new Error(`research run ${runId} could not be created or loaded`);
    return existing;
  }

  async updateRunState(runId: string, state: string, failure?: { code: string; message: string }): Promise<void> {
    await this.pool.query(
      `UPDATE research_runs SET state = $2, failure_code = $3, failure_message = $4, updated_at = now()
       WHERE run_id = $1`,
      [runId, state, failure?.code ?? null, failure?.message ?? null],
    );
  }

  async updateCounters(
    runId: string,
    counters: { modelCallsUsed: number; reservedMicros: number; spentMicros: number },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE research_runs
       SET model_calls_used = $2, reserved_micros = $3, spent_micros = $4, updated_at = now()
       WHERE run_id = $1`,
      [runId, counters.modelCallsUsed, counters.reservedMicros, counters.spentMicros],
    );
  }

  async appendStep(runId: string, step: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE research_runs
       SET steps = steps || $2::jsonb, updated_at = now()
       WHERE run_id = $1`,
      [runId, JSON.stringify([step])],
    );
  }

  async insertSource(input: {
    sourceId?: string;
    runId: string;
    providerId: string;
    candidateId: string;
    url: string;
    rationale?: string;
    relevance?: number;
  }): Promise<string> {
    const sourceId = input.sourceId ?? `src_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO research_sources (source_id, run_id, provider_id, candidate_id, url, rationale, relevance, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'discovered')
       ON CONFLICT (source_id) DO NOTHING`,
      [sourceId, input.runId, input.providerId, input.candidateId, input.url, input.rationale ?? '', input.relevance ?? 0],
    );
    return sourceId;
  }

  async getSource(sourceId: string): Promise<ResearchSourceRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM research_sources WHERE source_id = $1', [sourceId]);
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      sourceId: r.source_id as string,
      runId: r.run_id as string,
      providerId: r.provider_id as string,
      candidateId: r.candidate_id as string,
      url: r.url as string,
      finalUrl: (r.final_url as string) ?? null,
      rationale: (r.rationale as string) ?? '',
      relevance: Number(r.relevance ?? 0),
      status: r.status as string,
    };
  }

  async markSource(sourceId: string, status: string, finalUrl?: string): Promise<void> {
    await this.pool.query(
      'UPDATE research_sources SET status = $2, final_url = COALESCE($3, final_url) WHERE source_id = $1',
      [sourceId, status, finalUrl ?? null],
    );
  }

  async insertSnapshot(input: {
    snapshotId?: string;
    runId: string;
    sourceId: string;
    providerId: string;
    originalUrl: string;
    finalUrl: string;
    statusCode: number;
    contentType?: string;
    contentHash: string;
    bytes: number;
    truncated: boolean;
    etag?: string;
    lastModified?: string;
    storageKey?: string;
    excerpt?: string;
    fetchedAt: string;
    errorCode?: string;
  }): Promise<string> {
    const snapshotId = input.snapshotId ?? `snap_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO research_snapshots
         (snapshot_id, run_id, source_id, provider_id, original_url, final_url, status_code,
          content_type, content_hash, bytes, truncated, etag, last_modified, storage_key,
          excerpt, fetched_at, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (snapshot_id) DO NOTHING`,
      [
        snapshotId, input.runId, input.sourceId, input.providerId, input.originalUrl,
        input.finalUrl, input.statusCode, input.contentType ?? null, input.contentHash,
        input.bytes, input.truncated, input.etag ?? null, input.lastModified ?? null,
        input.storageKey ?? null, input.excerpt ?? null, input.fetchedAt, input.errorCode ?? null,
      ],
    );
    return snapshotId;
  }

  async getSnapshot(snapshotId: string): Promise<ResearchSnapshotRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM research_snapshots WHERE snapshot_id = $1', [snapshotId]);
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      snapshotId: r.snapshot_id as string,
      runId: r.run_id as string,
      sourceId: r.source_id as string,
      providerId: r.provider_id as string,
      originalUrl: r.original_url as string,
      finalUrl: r.final_url as string,
      statusCode: Number(r.status_code),
      contentType: (r.content_type as string) ?? null,
      contentHash: r.content_hash as string,
      bytes: Number(r.bytes),
      truncated: Boolean(r.truncated),
      etag: (r.etag as string) ?? null,
      lastModified: (r.last_modified as string) ?? null,
      storageKey: (r.storage_key as string) ?? null,
      excerpt: (r.excerpt as string) ?? null,
      fetchedAt: (r.fetched_at as Date).toISOString(),
      errorCode: (r.error_code as string) ?? null,
    };
  }

  async insertFacts(
    facts: Array<{
      runId: string;
      snapshotId: string;
      factText: string;
      claimKind: string;
      dateValue?: string | null;
      datePrecision?: string | null;
      evidenceSpans?: unknown[];
    }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const f of facts) {
      const factId = `fact_${randomUUID()}`;
      await this.pool.query(
        `INSERT INTO research_facts
           (fact_id, run_id, snapshot_id, fact_text, claim_kind, date_value, date_precision, evidence_spans)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (fact_id) DO NOTHING`,
        [
          factId, f.runId, f.snapshotId, f.factText, f.claimKind,
          f.dateValue ?? null, f.datePrecision ?? null, JSON.stringify(f.evidenceSpans ?? []),
        ],
      );
      ids.push(factId);
    }
    return ids;
  }

  async listFactsByRun(runId: string): Promise<ResearchFactRow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM research_facts WHERE run_id = $1 ORDER BY created_at ASC',
      [runId],
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        factId: row.fact_id as string,
        runId: row.run_id as string,
        snapshotId: row.snapshot_id as string,
        factText: row.fact_text as string,
        claimKind: row.claim_kind as string,
        dateValue: (row.date_value as string) ?? null,
        datePrecision: (row.date_precision as string) ?? null,
        evidenceSpans: (row.evidence_spans as unknown[]) ?? [],
      };
    });
  }

  async upsertDraft(input: {
    draftId: string;
    runId: string;
    sections: unknown[];
    lifecycleProposal: unknown;
    modelCallIds: string[];
    status?: string;
    preflightReport?: unknown;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO research_drafts (draft_id, run_id, sections, lifecycle_proposal, model_call_ids, status, preflight_report, updated_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7::jsonb, now())
       ON CONFLICT (draft_id) DO UPDATE SET
         sections = EXCLUDED.sections,
         lifecycle_proposal = EXCLUDED.lifecycle_proposal,
         model_call_ids = EXCLUDED.model_call_ids,
         status = EXCLUDED.status,
         preflight_report = EXCLUDED.preflight_report,
         updated_at = now()`,
      [
        input.draftId,
        input.runId,
        JSON.stringify(input.sections),
        JSON.stringify(input.lifecycleProposal ?? null),
        JSON.stringify(input.modelCallIds),
        input.status ?? 'draft',
        JSON.stringify(input.preflightReport ?? null),
      ],
    );
  }

  async getDraft(draftId: string): Promise<ResearchDraftRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM research_drafts WHERE draft_id = $1', [draftId]);
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      draftId: r.draft_id as string,
      runId: r.run_id as string,
      sections: (r.sections as unknown[]) ?? [],
      lifecycleProposal: r.lifecycle_proposal ?? null,
      modelCallIds: (r.model_call_ids as string[]) ?? [],
      status: r.status as string,
      preflightReport: r.preflight_report ?? null,
    };
  }
}
