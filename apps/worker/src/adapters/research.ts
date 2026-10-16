/**
 * Real @afterbyte/research adapter for the worker.
 *
 * Implements the ResearchPackage interface (moved here from
 * src/shims/research.ts when the shims were deleted) by composing the real
 * @afterbyte/research primitives: provider adapters (website/RSS/GitHub),
 * the model client with versioned prompt templates, the lifecycle policy,
 * the security sanitizer and the dedup helpers.
 *
 * The worker orchestrates (one pipeline step per job, leases, cancellation,
 * budgets); this adapter executes the domain work and persists it to the
 * worker's research tables (researchStore.ts).
 *
 * Honest behaviors:
 * - No MODEL_PROVIDER_KEY (or base URL / model id) -> providerUnavailable,
 *   runs stay awaiting_provider; public reads are unaffected.
 * - Provider health() is consulted before every step; disabled or
 *   quota-exhausted providers are skipped and reported, never faked.
 * - Source text is hostile quoted data: wrapped via wrapAsData and never
 *   interpolated into system instructions.
 * - Model outputs are validated against the versioned JSON schemas; at most
 *   two repair attempts (inside ModelClient), then flagged for review.
 * - Missing data is not negative evidence: lifecycle proposals say
 *   'uncertain' when the evidence is thin, never 'discontinued' on a
 *   single failed fetch.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import {
  WebsiteAdapter,
  RssAdapter,
  GitHubAdapter,
  type ResearchProvider,
  type DiscoverContext,
  type CandidateSource,
  type SubjectKind,
} from '@afterbyte/research';
import {
  ModelClient,
  makeOpenAICompatibleProvider,
  validateSchema,
  citationGateDecision,
  createBudgetLedger,
  type CitationCheck,
  type ClaimKind,
  type JsonSchema,
  type ResearchRun,
  type BudgetLedger,
} from '@afterbyte/research';
import { DEFAULT_CAPS, type RunCaps } from '@afterbyte/research';
import { evaluateLifecycle, type EvidenceSignal } from '@afterbyte/research';
import { wrapAsData } from '@afterbyte/research';
import { urlFingerprint } from '@afterbyte/research';
import type { Logger } from '../logging.js';
import { PermanentError, TransientError } from '../errors.js';
import { jobKeys } from '../queues.js';
import type { StorageAdapter } from './storage.js';
import { ResearchStore, type ResearchRunRow } from './researchStore.js';

export interface ResearchStepResult {
  /** IDs of rows the step wrote (snapshots, facts, draft sections...). */
  outputIds: string[];
  /** Outbox events the step wants emitted after its own transaction commits. */
  nextEvents: Array<{
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }>;
  /** True when the provider reported it cannot serve this step. */
  providerUnavailable?: boolean;
}

export interface ResearchPackage {
  runDiscoveryStep(runId: string, signal: { cancelled: boolean }): Promise<ResearchStepResult>;
  runFetchStep(runId: string, sourceId: string, signal: { cancelled: boolean }): Promise<ResearchStepResult>;
  runExtractStep(runId: string, sourceSnapshotId: string, signal: { cancelled: boolean }): Promise<ResearchStepResult>;
  runDraftStep(runId: string, dossierDraftId: string, signal: { cancelled: boolean }): Promise<ResearchStepResult>;
  /**
   * Schema + citation checks (brief §7 step 8). Throws PermanentError when
   * the draft is structurally invalid so it goes to failed review, never retried.
   */
  runReviewPreflight(dossierDraftId: string, signal: { cancelled: boolean }): Promise<ResearchStepResult>;
}

interface TemplateBundle {
  templateId: string;
  templateVersion: string;
  schemaVersion: string;
  prompt: string;
  schema: JsonSchema;
}

function loadTemplate(templateId: string): TemplateBundle {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('@afterbyte/research/package.json');
  const dir = join(dirname(pkgJson), 'prompts', 'v1');
  const manifest = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
    templates: Record<string, { prompt: string; schema: string; schemaVersion: string; templateVersion: string }>;
  };
  const entry = manifest.templates[templateId];
  if (!entry) throw new Error(`unknown research template: ${templateId}`);
  return {
    templateId,
    templateVersion: entry.templateVersion,
    schemaVersion: entry.schemaVersion,
    prompt: readFileSync(join(dir, entry.prompt), 'utf8'),
    schema: JSON.parse(readFileSync(join(dir, entry.schema), 'utf8')) as JsonSchema,
  };
}

function createProviders(rssFeedUrls: string[]): ResearchProvider[] {
  return [new WebsiteAdapter(), new RssAdapter(rssFeedUrls), new GitHubAdapter()];
}

function createModelClient(): ModelClient | null {
  const key = process.env.MODEL_PROVIDER_KEY;
  const baseUrl = process.env.MODEL_PROVIDER_BASE_URL;
  const modelId = process.env.MODEL_PROVIDER_MODEL_ID;
  if (!key || !baseUrl || !modelId) return null;
  return new ModelClient(makeOpenAICompatibleProvider({ baseUrl, apiKey: key, modelId }), {
    pricing: { promptPer1kMicros: 250, completionPer1kMicros: 1250 },
    estimatedCostMicrosPerCall: 50_000,
    maxRepairAttempts: 2,
    callTimeoutMs: 120_000,
  });
}

export interface ResearchAdapterOptions {
  pool: Pool;
  storage: StorageAdapter | null;
  logger?: Logger;
  /** Extra RSS feed URLs beyond the adapter defaults. */
  rssFeedUrls?: string[];
  /** Daily model-spend ceiling, micro-USD. Default $5. */
  dailyMaxMicros?: number;
}

const UNAVAILABLE: ResearchStepResult = { outputIds: [], nextEvents: [], providerUnavailable: true };

function throwIfCancelled(signal: { cancelled: boolean }): void {
  if (signal.cancelled) throw new Error('research step cancelled');
}

/** Map a worker research_runs row onto the pipeline's ResearchRun shape. */
function rowToResearchRun(row: ResearchRunRow): ResearchRun {
  const now = new Date().toISOString();
  return {
    runId: row.runId,
    subjectId: row.runId,
    subjectName: row.subjectName,
    subjectKind: row.subjectKind as SubjectKind,
    state: 'running',
    caps: { ...DEFAULT_CAPS, ...(row.caps as Partial<RunCaps>) },
    steps: [],
    modelCallsUsed: row.modelCallsUsed,
    reservedMicros: row.reservedMicros,
    spentMicros: row.spentMicros,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

export function createResearchAdapter(opts: ResearchAdapterOptions): ResearchPackage & {
  /** Register a research run row (ops/admin tooling). */
  registerRun(input: {
    runId?: string;
    subjectName: string;
    subjectKind: string;
    aliases?: string[];
    knownUrls?: string[];
  }): Promise<string>;
  store: ResearchStore;
} {
  const store = new ResearchStore(opts.pool);
  const providers = createProviders(opts.rssFeedUrls ?? []);
  const logger = opts.logger;
  // Process-wide daily budget ledger (brief §7: reserve before dispatch).
  const ledger: BudgetLedger = createBudgetLedger(opts.dailyMaxMicros ?? 5_000_000);

  async function availableProviders(): Promise<ResearchProvider[]> {
    const ok: ResearchProvider[] = [];
    for (const p of providers) {
      try {
        const h = await p.health();
        if (h.availability === 'available') ok.push(p);
        else logger?.warn('provider not available', { providerId: p.providerId, reason: h.reason });
      } catch (err) {
        logger?.warn('provider health check failed', { providerId: p.providerId, error: String(err) });
      }
    }
    return ok;
  }

  /** Persist the pipeline run's counters back to the row after model calls. */
  async function syncCounters(runId: string, run: ResearchRun): Promise<void> {
    await store.updateCounters(runId, {
      modelCallsUsed: run.modelCallsUsed,
      reservedMicros: run.reservedMicros,
      spentMicros: run.spentMicros,
    });
  }

  const api: ResearchPackage = {
    async runDiscoveryStep(runId, signal): Promise<ResearchStepResult> {
      throwIfCancelled(signal);
      const run = await store.getRun(runId);
      if (!run) {
        throw new PermanentError(
          'research-run-not-found',
          `research run ${runId} not found in worker state — register it via the research adapter before dispatching discovery`,
        );
      }
      const caps = { ...DEFAULT_CAPS, ...(run.caps as Partial<RunCaps>) };
      const live = await availableProviders();
      if (live.length === 0) return UNAVAILABLE;

      const ctx: DiscoverContext = {
        subjectName: run.subjectName,
        subjectKind: run.subjectKind as SubjectKind,
        aliases: run.aliases,
        knownUrls: run.knownUrls,
        maxCandidates: caps.maxCandidateSources,
      };

      const seen = new Set<string>();
      const candidates: Array<{ provider: ResearchProvider; candidate: CandidateSource }> = [];
      for (const p of live) {
        throwIfCancelled(signal);
        let found: CandidateSource[] = [];
        try {
          found = await p.discover(ctx);
        } catch (err) {
          logger?.warn('provider discover failed', { providerId: p.providerId, error: String(err) });
          continue;
        }
        for (const c of found) {
          const fp = urlFingerprint(c.url);
          if (seen.has(fp)) continue; // syndication/duplicates don't count twice
          seen.add(fp);
          candidates.push({ provider: p, candidate: c });
          if (candidates.length >= caps.maxCandidateSources) break;
        }
        if (candidates.length >= caps.maxCandidateSources) break;
      }

      const outputIds: string[] = [];
      const nextEvents: ResearchStepResult['nextEvents'] = [];
      for (const { provider, candidate } of candidates) {
        const sourceId = await store.insertSource({
          runId,
          providerId: provider.providerId,
          candidateId: candidate.candidateId,
          url: candidate.url,
          rationale: candidate.rationale,
          relevance: candidate.estimatedRelevance,
        });
        outputIds.push(sourceId);
        nextEvents.push({
          aggregateType: 'research',
          aggregateId: runId,
          eventType: 'research.source.fetch.requested',
          payload: { runId, sourceId, jobKey: jobKeys.fetch(runId, sourceId) },
        });
      }

      await store.updateRunState(runId, 'running');
      await store.appendStep(runId, {
        step: 'discover_candidate',
        status: candidates.length > 0 ? 'ok' : 'partial',
        summary: `${candidates.length} candidate sources from ${live.length} providers`,
        at: new Date().toISOString(),
      });
      return { outputIds, nextEvents };
    },

    async runFetchStep(runId, sourceId, signal): Promise<ResearchStepResult> {
      throwIfCancelled(signal);
      const source = await store.getSource(sourceId);
      if (!source) throw new PermanentError('research-source-not-found', `source ${sourceId} not found`);
      const provider = providers.find((p) => p.providerId === source.providerId);
      if (!provider) throw new PermanentError('research-provider-unknown', `provider ${source.providerId} unknown`);
      const health = await provider.health();
      if (health.availability !== 'available') return UNAVAILABLE;

      let outcome;
      try {
        outcome = await provider.fetch(
          { candidateId: source.candidateId, url: source.url, rationale: source.rationale, estimatedRelevance: source.relevance },
          {},
        );
      } catch (err) {
        throw new TransientError(`provider fetch failed: ${String(err)}`);
      }
      if (outcome.error) {
        if (outcome.error.retryable) throw new TransientError(`fetch retryable: ${outcome.error.message}`);
        await store.markSource(sourceId, 'failed');
        await store.insertSnapshot({
          runId,
          sourceId,
          providerId: source.providerId,
          originalUrl: source.url,
          finalUrl: source.url,
          statusCode: 0,
          contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          bytes: 0,
          truncated: false,
          fetchedAt: new Date().toISOString(),
          errorCode: outcome.error.code,
        });
        return { outputIds: [], nextEvents: [] }; // coverage gap, not a failure
      }
      if (outcome.notModified) {
        await store.markSource(sourceId, 'fetched');
        return { outputIds: [], nextEvents: [] };
      }
      const snap = outcome.snapshot!;
      throwIfCancelled(signal);

      // Persist raw bytes to the private bucket (access-controlled, never public).
      let storageKey: string | null = null;
      if (opts.storage) {
        storageKey = `research/snapshots/${runId}/${snap.snapshotId}.bin`;
        await opts.storage.putPrivateObject(storageKey, Buffer.from(snap.body), snap.contentType ?? 'application/octet-stream');
      }
      const normalized = await provider.normalize(snap);
      const snapshotId = await store.insertSnapshot({
        snapshotId: snap.snapshotId,
        runId,
        sourceId,
        providerId: snap.providerId,
        originalUrl: snap.originalUrl,
        finalUrl: snap.finalUrl,
        statusCode: snap.statusCode,
        contentType: snap.contentType,
        contentHash: snap.contentHash,
        bytes: snap.bytes,
        truncated: snap.truncated,
        etag: snap.etag ?? undefined,
        lastModified: snap.lastModified ?? undefined,
        storageKey: storageKey ?? undefined,
        excerpt: normalized.excerpt,
        fetchedAt: snap.fetchedAt,
      });
      await store.markSource(sourceId, 'fetched', snap.finalUrl);
      return {
        outputIds: [snapshotId],
        nextEvents: [
          {
            aggregateType: 'research',
            aggregateId: runId,
            eventType: 'research.snapshot.extract.requested',
            payload: { runId, sourceSnapshotId: snapshotId, jobKey: jobKeys.extract(runId, snapshotId) },
          },
        ],
      };
    },

    async runExtractStep(runId, sourceSnapshotId, signal): Promise<ResearchStepResult> {
      throwIfCancelled(signal);
      const snapshot = await store.getSnapshot(sourceSnapshotId);
      if (!snapshot) throw new PermanentError('research-snapshot-not-found', `snapshot ${sourceSnapshotId} not found`);
      const model = createModelClient();
      if (!model) return UNAVAILABLE;
      const runRow = await store.getRun(runId);
      if (!runRow) throw new PermanentError('research-run-not-found', `research run ${runId} not found`);

      const tpl = loadTemplate('extract-facts');
      const { fenced } = wrapAsData(snapshot.excerpt ?? '');
      const userPrompt =
        `${tpl.prompt}\n\n## Runtime input (JSON)\n` +
        JSON.stringify(
          { snapshotId: snapshot.snapshotId, url: snapshot.finalUrl, fetchedAt: snapshot.fetchedAt, contentHash: snapshot.contentHash },
          null,
          2,
        );
      const { record, run: updatedRun } = await model.runStep(
        rowToResearchRun(runRow),
        ledger,
        {
          templateId: tpl.templateId,
          templateVersion: tpl.templateVersion,
          schemaVersion: tpl.schemaVersion,
          systemPrompt: 'You are an evidence extractor. Output strict JSON only.',
          userPrompt,
          sourceData: [fenced],
          schema: tpl.schema,
          maxTokens: 4000,
        },
        (output) => {
          const o = output as { facts?: unknown[] };
          return `extracted ${o.facts?.length ?? 0} facts`;
        },
      );
      await syncCounters(runId, updatedRun);
      if (record.status === 'flagged') {
        logger?.warn('extract step flagged for review', { snapshotId: snapshot.snapshotId, reason: record.flagReason });
      }
      const output = record.output as {
        facts: Array<{
          claim: string;
          confidence: 'limited' | 'moderate' | 'strong';
          dates: Array<{ value: string | null; precision: string }>;
          quote: string;
          spanStart: number;
          spanEnd: number;
        }>;
        contradictions: Array<{ claimA: string; claimB: string }>;
      };
      const contradicted = new Set((output.contradictions ?? []).flatMap((c) => [c.claimA, c.claimB]));
      const facts = (output.facts ?? []).map((f) => ({
        runId,
        snapshotId: snapshot.snapshotId,
        factText: f.claim,
        claimKind: contradicted.has(f.claim) ? 'disputed' : f.confidence === 'limited' ? 'inference' : 'sourced_fact',
        dateValue: f.dates?.[0]?.value ?? null,
        datePrecision: f.dates?.[0]?.precision ?? null,
        evidenceSpans: [{ quote: f.quote, spanStart: f.spanStart, spanEnd: f.spanEnd }],
      }));
      const factIds = await store.insertFacts(facts);
      await store.appendStep(runId, {
        step: 'extract_facts',
        status: record.status === 'flagged' ? 'partial' : 'ok',
        summary: `extracted ${factIds.length} facts from ${sourceSnapshotId} (${record.status})`,
        at: new Date().toISOString(),
      });
      return { outputIds: factIds, nextEvents: [] };
    },

    async runDraftStep(runId, dossierDraftId, signal): Promise<ResearchStepResult> {
      throwIfCancelled(signal);
      const facts = await store.listFactsByRun(runId);
      if (facts.length === 0) {
        throw new PermanentError('research-no-facts', `no extracted facts for run ${runId} — nothing to draft from`);
      }
      const model = createModelClient();
      if (!model) return UNAVAILABLE;
      const runRow = await store.getRun(runId);
      if (!runRow) throw new PermanentError('research-run-not-found', `research run ${runId} not found`);

      // Lifecycle proposal from the versioned policy (brief §5): missing data
      // is not negative evidence — thin evidence proposes 'uncertain'.
      const signals: EvidenceSignal[] = facts.map((f) => ({
        type: 'source_claim',
        description: f.factText,
        observedAt: f.dateValue ?? new Date().toISOString(),
        snapshotId: f.snapshotId,
        strength: f.claimKind === 'sourced_fact' ? ('strong' as const) : ('weak' as const),
      }));
      const lifecycle = evaluateLifecycle(
        {
          subjectKind: runRow.subjectKind as SubjectKind,
          signals,
          coverageGaps: [],
        },
        Date.now(),
      );

      const tpl = loadTemplate('draft-sections');
      const { fenced } = wrapAsData(
        JSON.stringify(
          facts.map((f) => ({ factId: f.factId, text: f.factText, kind: f.claimKind, date: f.dateValue, precision: f.datePrecision })),
          null,
          2,
        ),
      );
      const userPrompt =
        `${tpl.prompt}\n\n## Runtime input (JSON)\n` +
        JSON.stringify(
          {
            dossierDraftId,
            // No editorial decision exists yet at draft time: pass the
            // policy proposal explicitly, never as a decided status.
            approvedStatus: lifecycle.proposedStatus,
            statusNote: `proposed by lifecycle policy (${lifecycle.policyVersion}), not yet editorially decided`,
            previousVersion: null,
          },
          null,
          2,
        );
      const { record, run: updatedRun } = await model.runStep(
        rowToResearchRun(runRow),
        ledger,
        {
          templateId: tpl.templateId,
          templateVersion: tpl.templateVersion,
          schemaVersion: tpl.schemaVersion,
          systemPrompt: 'You are a dossier drafter. Output strict JSON only.',
          userPrompt,
          sourceData: [fenced],
          schema: tpl.schema,
          maxTokens: 6000,
        },
        (output) => {
          const o = output as { sections?: unknown[] };
          return `drafted ${o.sections?.length ?? 0} sections`;
        },
      );
      await syncCounters(runId, updatedRun);
      const output = record.output as { sections?: unknown[] };
      const sections = output.sections ?? [];
      await store.upsertDraft({
        draftId: dossierDraftId,
        runId,
        sections,
        lifecycleProposal: {
          status: lifecycle.proposedStatus,
          reason: lifecycle.reason,
          confidence: lifecycle.confidence,
          policyVersion: lifecycle.policyVersion,
        },
        modelCallIds: [record.callId],
        status: 'draft',
      });
      await store.appendStep(runId, {
        step: 'draft_sections',
        status: record.status === 'flagged' ? 'partial' : 'ok',
        summary: `drafted ${sections.length} sections for ${dossierDraftId} (${record.status})`,
        at: new Date().toISOString(),
      });
      return {
        outputIds: [dossierDraftId],
        nextEvents: [
          {
            aggregateType: 'editorial',
            aggregateId: dossierDraftId,
            eventType: 'editorial.review.preflight.requested',
            payload: { dossierDraftId, jobKey: jobKeys.reviewPreflight(dossierDraftId) },
          },
        ],
      };
    },

    async runReviewPreflight(dossierDraftId, signal): Promise<ResearchStepResult> {
      throwIfCancelled(signal);
      const draft = await store.getDraft(dossierDraftId);
      if (!draft) throw new PermanentError('research-draft-not-found', `draft ${dossierDraftId} not found`);

      // (1) Structural validation against the versioned draft schema.
      const tpl = loadTemplate('draft-sections');
      const issues = validateSchema(tpl.schema, { sections: draft.sections });
      if (issues.length > 0) {
        await store.upsertDraft({
          draftId: dossierDraftId,
          runId: draft.runId,
          sections: draft.sections,
          lifecycleProposal: draft.lifecycleProposal,
          modelCallIds: draft.modelCallIds,
          status: 'preflight_failed',
          preflightReport: { decision: 'fail', issues },
        });
        throw new PermanentError(
          'preflight-schema-invalid',
          `draft ${dossierDraftId} failed structural validation: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
        );
      }

      // (2) Citation gate: every claimId referenced by a block must resolve
      // to an extracted fact for this run; unsupported dates/quantities/
      // allegations fail the gate (brief §7 step 8, §22).
      const facts = await store.listFactsByRun(draft.runId);
      const factById = new Map(facts.map((f) => [f.factId, f]));
      const checks: CitationCheck[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (node && typeof node === 'object') {
          const rec = node as Record<string, unknown>;
          const claimIds = rec.claimIds;
          if (Array.isArray(claimIds)) {
            for (const id of claimIds) {
              const fact = factById.get(String(id));
              let kind: ClaimKind = 'other';
              if (fact && /date|when/i.test(fact.factText)) kind = 'date';
              else if (fact && /\d/.test(fact.factText)) kind = 'quantity';
              checks.push({
                claimId: String(id),
                verdict: fact ? 'supported' : 'unsupported',
                kind,
              });
            }
          }
          for (const [k, v] of Object.entries(rec)) {
            if (k !== 'claimIds') walk(v);
          }
        }
      };
      walk(draft.sections);
      const gate = citationGateDecision(checks);
      const report = {
        decision: gate.decision,
        unsupported: gate.unsupported,
        totalChecks: checks.length,
        at: new Date().toISOString(),
      };
      await store.upsertDraft({
        draftId: dossierDraftId,
        runId: draft.runId,
        sections: draft.sections,
        lifecycleProposal: draft.lifecycleProposal,
        modelCallIds: draft.modelCallIds,
        status: gate.decision === 'pass' ? 'preflight_ok' : 'preflight_failed',
        preflightReport: report,
      });
      if (gate.decision === 'fail') {
        throw new PermanentError(
          'preflight-citations-unsupported',
          `draft ${dossierDraftId} has unsupported claims: ${gate.unsupported.join(', ')}`,
        );
      }
      return { outputIds: [dossierDraftId], nextEvents: [] };
    },
  };

  return Object.assign(api, {
    async registerRun(input: {
      runId?: string;
      subjectName: string;
      subjectKind: string;
      aliases?: string[];
      knownUrls?: string[];
    }): Promise<string> {
      const row = await store.createRun(input);
      return row.runId;
    },
    store,
  });
}
