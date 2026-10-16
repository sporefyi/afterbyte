/**
 * Model-provider adapter (brief §7): the model provider is an adapter.
 *
 * - MODEL_PROVIDER_KEY comes from the environment. When it is absent the
 *   factory returns null and runs stay in `awaiting_provider` — public reads
 *   of published content are unaffected.
 * - Every call records: model id, prompt-template version, output-schema
 *   version, and token usage.
 * - Every output is validated against a static schema. At most 2 repair
 *   attempts, then the call is flagged for human review.
 * - Only concise decision summaries and observable steps are saved — never
 *   hidden chain-of-thought.
 * - Monetary ceilings are enforced alongside counts (see pipeline
 *   canDispatchModelCall / reserveBudget).
 * - A charged non-idempotent request that times out ambiguously is NEVER
 *   retried blindly: it is recorded as `ambiguous` and surfaced for review.
 */
import { randomUUID } from 'node:crypto';
import { canDispatchModelCall, reserveBudget, settleReservation, type BudgetLedger, type ResearchRun } from './pipeline.js';
import { buildModelMessages } from './security.js';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Raw completion from the provider transport. */
export interface ProviderCompletion {
  text: string;
  usage: TokenUsage;
  /** Provider-side request id for idempotency tracking. */
  requestId?: string;
}

export interface ModelProvider {
  /** e.g. "anthropic/claude-haiku-4.5 via orbio". */
  modelId: string;
  complete(req: {
    system: string;
    user: string;
    /** Max output tokens. */
    maxTokens: number;
    /** Idempotency key — the provider must not double-charge a retried key. */
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderCompletion>;
}

export interface Pricing {
  /** Micro-USD per 1k prompt tokens. */
  promptPer1kMicros: number;
  /** Micro-USD per 1k completion tokens. */
  completionPer1kMicros: number;
}

export interface ModelCallInput {
  templateId: string; // e.g. "plan"
  templateVersion: string; // e.g. "plan-v1"
  schemaVersion: string; // e.g. "plan.schema-v1"
  systemPrompt: string;
  userPrompt: string;
  /** Hostile source excerpts to include as quoted data (never system). */
  sourceData?: string[];
  /** Static JSON schema the output must satisfy. */
  schema: JsonSchema;
  maxTokens?: number;
}

export type ModelCallStatus = 'ok' | 'repaired' | 'flagged' | 'ambiguous';

export interface ModelCallRecord {
  callId: string;
  runId: string;
  modelId: string;
  templateId: string;
  templateVersion: string;
  outputSchemaVersion: string;
  status: ModelCallStatus;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  usage: TokenUsage & { costMicros: number };
  /** Concise decision summary — never chain-of-thought. */
  decisionSummary: string;
  /** Observable steps taken (e.g. "validated against plan.schema-v1"). */
  observableSteps: string[];
  output: unknown;
  flagReason?: string;
}

export class ProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(`model provider unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

export class ModelBudgetError extends Error {
  constructor(reason: string) {
    super(`model call blocked by budget: ${reason}`);
    this.name = 'ModelBudgetError';
  }
}

/* ------------------------------------------------------------------ */
/* Minimal strict JSON-Schema validator (subset of draft-07)           */
/* ------------------------------------------------------------------ */

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateSchema(schema: JsonSchema, value: unknown, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (message: string) => issues.push({ path, message });

  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    fail(`must be one of ${JSON.stringify(schema.enum)}`);
    return issues;
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validateSchema(s, value, path).length === 0);
    if (!ok) fail('does not match any allowed variant');
    return issues;
  }
  const t = schema.type;
  if (!t) return issues;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const typeOk =
    t === 'integer' ? actual === 'number' && Number.isInteger(value) : actual === t;
  if (!typeOk) {
    fail(`expected ${t}, got ${actual}`);
    return issues;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) issues.push({ path: `${path}.${key}`, message: 'required property missing' });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) issues.push(...validateSchema(sub, obj[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: 'additional property not allowed' });
      }
    }
  }
  if (t === 'array') {
    const arr = value as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) fail(`needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) fail(`allows at most ${schema.maxItems} items`);
    if (schema.items) arr.forEach((v, i) => issues.push(...validateSchema(schema.items!, v, `${path}[${i}]`)));
  }
  if (t === 'string') {
    const s = value as string;
    if (schema.minLength !== undefined && s.length < schema.minLength) fail(`shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && s.length > schema.maxLength) fail(`longer than maxLength ${schema.maxLength}`);
  }
  if (t === 'number' || t === 'integer') {
    const n = value as number;
    if (schema.minimum !== undefined && n < schema.minimum) fail(`below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && n > schema.maximum) fail(`above maximum ${schema.maximum}`);
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Model client                                                        */
/* ------------------------------------------------------------------ */

export interface ModelClientOptions {
  pricing: Pricing;
  /** Worst-case cost estimate per call attempt, micro-USD. */
  estimatedCostMicrosPerCall?: number;
  maxRepairAttempts?: number;
  callTimeoutMs?: number;
}

const DEFAULT_PRICING: Pricing = { promptPer1kMicros: 250, completionPer1kMicros: 1250 }; // ~haiku-class

function costMicros(usage: TokenUsage, pricing: Pricing): number {
  return Math.ceil((usage.promptTokens / 1000) * pricing.promptPer1kMicros + (usage.completionTokens / 1000) * pricing.completionPer1kMicros);
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

/**
 * Build a model client. Returns null when MODEL_PROVIDER_KEY is absent —
 * callers must then hold runs in `awaiting_provider` (never fail reads).
 */
export function createModelClientFromEnv(makeProvider: (key: string) => ModelProvider): ModelClient | null {
  const key = process.env['MODEL_PROVIDER_KEY'];
  if (!key) return null;
  return new ModelClient(makeProvider(key), { pricing: DEFAULT_PRICING });
}

export class ModelClient {
  private readonly maxRepairAttempts: number;
  private readonly callTimeoutMs: number;
  private readonly estimatedCostMicrosPerCall: number;

  constructor(
    private readonly provider: ModelProvider,
    private readonly opts: ModelClientOptions,
  ) {
    this.maxRepairAttempts = opts.maxRepairAttempts ?? 2;
    this.callTimeoutMs = opts.callTimeoutMs ?? 120_000;
    this.estimatedCostMicrosPerCall = opts.estimatedCostMicrosPerCall ?? 50_000; // $0.05
  }

  get modelId(): string {
    return this.provider.modelId;
  }

  /**
   * Run one templated model step with schema validation + bounded repair.
   * Budget is reserved BEFORE dispatch; on ambiguous timeout the reservation
   * is settled and the call is flagged — never retried blindly.
   */
  async runStep(
    run: ResearchRun,
    ledger: BudgetLedger,
    input: ModelCallInput,
    summarize: (output: unknown) => string,
  ): Promise<{ record: ModelCallRecord; run: ResearchRun; ledger: BudgetLedger }> {
    const gate = canDispatchModelCall(run, this.estimatedCostMicrosPerCall);
    if (!gate.ok) throw new ModelBudgetError(gate.reason ?? 'budget gate denied');

    const reserved = reserveBudget(ledger, run, this.estimatedCostMicrosPerCall);
    let curLedger = reserved.ledger;
    let curRun: ResearchRun = { ...reserved.run, modelCallsUsed: reserved.run.modelCallsUsed + 1 };
    const callId = `mcall_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const observableSteps: string[] = [];
    const idempotencyKey = `${run.runId}:${input.templateId}:${input.templateVersion}:${callId}`;

    const messages = buildModelMessages(input.systemPrompt, input.userPrompt, input.sourceData ?? []);
    let system = messages.system;
    let user = messages.user;

    let attempts = 0;
    let lastIssues: ValidationIssue[] = [];
    let completion: ProviderCompletion | null = null;
    let output: unknown = null;
    let status: ModelCallStatus = 'ok';
    let flagReason: string | undefined;

    try {
      while (attempts <= this.maxRepairAttempts) {
        attempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.callTimeoutMs);
        try {
          completion = await this.provider.complete({
            system,
            user,
            maxTokens: input.maxTokens ?? 2000,
            idempotencyKey: `${idempotencyKey}:a${attempts}`,
            signal: controller.signal,
          });
        } catch (err) {
          // Ambiguous timeout: the provider may or may not have charged us.
          // Record, settle, surface — NEVER retry blindly.
          if (err instanceof Error && /abort|timeout/i.test(err.message)) {
            status = 'ambiguous';
            flagReason = 'provider request timed out ambiguously; not retried to avoid double charge';
            observableSteps.push('provider timeout — recorded as ambiguous, no blind retry');
            break;
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
        observableSteps.push(`attempt ${attempts}: received ${completion.usage.promptTokens}+${completion.usage.completionTokens} tokens`);
        let parsed: unknown;
        try {
          parsed = extractJson(completion.text);
        } catch {
          lastIssues = [{ path: '$', message: 'output was not valid JSON' }];
          user = repairPrompt(user, lastIssues);
          continue;
        }
        lastIssues = validateSchema(input.schema, parsed);
        if (lastIssues.length === 0) {
          output = parsed;
          status = attempts === 1 ? 'ok' : 'repaired';
          observableSteps.push(`validated against ${input.schemaVersion}`);
          break;
        }
        observableSteps.push(`attempt ${attempts}: schema validation failed (${lastIssues.length} issue(s))`);
        if (attempts > this.maxRepairAttempts) break;
        user = repairPrompt(user, lastIssues);
      }

      if (status !== 'ambiguous' && (output === null || lastIssues.length > 0)) {
        status = 'flagged';
        flagReason = `schema validation failed after ${attempts} attempt(s): ${lastIssues.map((i) => `${i.path} ${i.message}`).join('; ')}`;
        observableSteps.push('flagged for human review');
      }

      const usage = completion?.usage ?? { promptTokens: 0, completionTokens: 0 };
      const actualCost = completion ? costMicros(usage, this.opts.pricing) : 0;
      const settled = settleReservation(curLedger, curRun, this.estimatedCostMicrosPerCall, actualCost);
      curLedger = settled.ledger;
      curRun = settled.run;

      const record: ModelCallRecord = {
        callId,
        runId: run.runId,
        modelId: this.provider.modelId,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        outputSchemaVersion: input.schemaVersion,
        status,
        attempts,
        startedAt,
        finishedAt: new Date().toISOString(),
        usage: { ...usage, costMicros: actualCost },
        decisionSummary: output !== null ? summarize(output) : (flagReason ?? 'no output'),
        observableSteps,
        output,
        flagReason,
      };
      return { record, run: curRun, ledger: curLedger };
    } catch (err) {
      // Non-ambiguous failure: release the reservation, rethrow.
      const settled = settleReservation(curLedger, curRun, this.estimatedCostMicrosPerCall, 0);
      if (err instanceof ModelBudgetError) throw err;
      throw new Error(`model step failed: ${(err as Error).message}`);
    }
  }
}

function repairPrompt(user: string, issues: ValidationIssue[]): string {
  const detail = issues.map((i) => `- ${i.path}: ${i.message}`).join('\n');
  return (
    `${user}\n\nYour previous output failed validation. Fix ONLY the issues below and return the complete corrected JSON (no prose, no markdown fences):\n${detail}`
  );
}

/* ------------------------------------------------------------------ */
/* Publication gate + date precision helpers (pure, testable)          */
/* ------------------------------------------------------------------ */

export type ClaimKind = 'date' | 'quantity' | 'allegation' | 'other';

export interface CitationCheck {
  claimId: string;
  verdict: 'supported' | 'partial' | 'unsupported';
  kind: ClaimKind;
}

/**
 * Publication gate (citation-check-v1): any unsupported date, quantity, or
 * allegation fails the run. Unsupported non-critical context does not.
 */
export function citationGateDecision(checks: CitationCheck[]): {
  decision: 'pass' | 'fail';
  unsupported: string[];
} {
  const unsupported = checks.filter((c) => c.verdict === 'unsupported' && c.kind !== 'other');
  return { decision: unsupported.length > 0 ? 'fail' : 'pass', unsupported: unsupported.map((c) => c.claimId) };
}

export type DatePrecision = 'day' | 'yearMonth' | 'year' | 'null';

/**
 * Coerce a model-supplied date to (value, precision). Approximate dates stay
 * approximate: "2015" never becomes "2015-01-01". Unparseable input becomes
 * null — never a guess.
 */
export function coerceDatePrecision(
  value: string | null,
  _claimed: DatePrecision,
): { value: string | null; precision: DatePrecision } {
  if (value == null) return { value: null, precision: 'null' };
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))) return { value: v, precision: 'day' };
  if (/^\d{4}-\d{2}$/.test(v)) return { value: v, precision: 'yearMonth' };
  if (/^\d{4}$/.test(v)) return { value: v, precision: 'year' };
  return { value: null, precision: 'null' };
}

/**
 * OpenAI-compatible chat-completions transport. The concrete endpoint is
 * configured by the deployer (MODEL_PROVIDER_URL); the key is never logged.
 */
export function makeOpenAICompatibleProvider(opts: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): ModelProvider {
  return {
    modelId: opts.modelId,
    async complete(req) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${opts.apiKey}`,
            'Idempotency-Key': req.idempotencyKey,
          },
          body: JSON.stringify({
            model: opts.modelId,
            max_tokens: req.maxTokens,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`model provider HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          id?: string;
        };
        const text = json.choices?.[0]?.message?.content ?? '';
        return {
          text,
          usage: {
            promptTokens: json.usage?.prompt_tokens ?? 0,
            completionTokens: json.usage?.completion_tokens ?? 0,
          },
          requestId: json.id,
        };
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
