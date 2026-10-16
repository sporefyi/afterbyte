import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModelBudgetError,
  ModelClient,
  ProviderUnavailableError,
  citationGateDecision,
  coerceDatePrecision,
  createModelClientFromEnv,
  validateSchema,
  type JsonSchema,
  type ModelCallInput,
  type ModelProvider,
} from '../src/model.js';
import { createBudgetLedger, createRun, transition } from '../src/pipeline.js';

const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    planId: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { stepId: { type: 'string' }, adapter: { type: 'string' } },
        required: ['stepId', 'adapter'],
        additionalProperties: false,
      },
    },
  },
  required: ['planId', 'steps'],
  additionalProperties: false,
};

function fakeProvider(responses: Array<string | Error>, usage = { promptTokens: 10, completionTokens: 20 }): ModelProvider & { calls: number } {
  const p = {
    calls: 0,
    modelId: 'test/fake-model',
    async complete() {
      p.calls += 1;
      const r = responses[Math.min(p.calls - 1, responses.length - 1)];
      if (r instanceof Error) throw r;
      return { text: r as string, usage: { ...usage } };
    },
  };
  return p;
}

const baseInput = (overrides: Partial<ModelCallInput> = {}): ModelCallInput => ({
  templateId: 'plan',
  templateVersion: 'plan-v1',
  schemaVersion: 'plan.schema-v1',
  systemPrompt: 'Output JSON only.',
  userPrompt: 'Make a plan.',
  schema: PLAN_SCHEMA,
  ...overrides,
});

const runReady = () => transition(createRun({ subjectId: 's', subjectName: 'S', subjectKind: 'app' }), 'running');

describe('validateSchema', () => {
  it('accepts valid output', () => {
    const issues = validateSchema(PLAN_SCHEMA, { planId: 'plan-1', steps: [{ stepId: 's1', adapter: 'website' }] });
    expect(issues).toEqual([]);
  });

  it('rejects missing required, wrong types, and extra props', () => {
    const issues = validateSchema(PLAN_SCHEMA, { steps: [{ stepId: 's1', adapter: 'website', extra: 1 }] });
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('$.planId');
    expect(paths).toContain('$.steps[0].extra');
  });

  it('rejects enum violations and bad integers', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        status: { enum: ['active', 'dormant'] },
        n: { type: 'integer', minimum: 1 },
      },
      required: ['status', 'n'],
    };
    const issues = validateSchema(schema, { status: 'gone', n: 1.5 });
    expect(issues).toHaveLength(2);
  });
});

describe('ModelClient.runStep', () => {
  const pricing = { promptPer1kMicros: 1000, completionPer1kMicros: 1000 };

  it('records model id, template + schema versions, usage, and cost', async () => {
    const provider = fakeProvider([JSON.stringify({ planId: 'plan-1', steps: [] })]);
    const client = new ModelClient(provider, { pricing });
    const ledger = createBudgetLedger(1_000_000);
    const { record, run } = await client.runStep(runReady(), ledger, baseInput(), (o) => `plan ${(o as { planId: string }).planId}`);
    expect(record.status).toBe('ok');
    expect(record.modelId).toBe('test/fake-model');
    expect(record.templateVersion).toBe('plan-v1');
    expect(record.outputSchemaVersion).toBe('plan.schema-v1');
    expect(record.usage).toMatchObject({ promptTokens: 10, completionTokens: 20 });
    expect(record.usage.costMicros).toBeGreaterThan(0);
    expect(record.decisionSummary).toBe('plan plan-1');
    expect(run.modelCallsUsed).toBe(1);
    expect(run.spentMicros).toBe(record.usage.costMicros);
  });

  it('repairs malformed output up to 2 times, then flags for review', async () => {
    const bad = JSON.stringify({ planId: 'plan-1' }); // missing steps
    const provider = fakeProvider([bad, bad, bad]);
    const client = new ModelClient(provider, { pricing, maxRepairAttempts: 2 });
    const { record } = await client.runStep(runReady(), createBudgetLedger(1_000_000), baseInput(), () => 'x');
    expect(provider.calls).toBe(3); // 1 initial + 2 repairs
    expect(record.status).toBe('flagged');
    expect(record.attempts).toBe(3);
    expect(record.flagReason).toMatch(/schema validation failed/);
    expect(record.observableSteps.join(' ')).toMatch(/flagged for human review/);
  });

  it('marks repaired when the second attempt validates', async () => {
    const provider = fakeProvider(['not json', JSON.stringify({ planId: 'plan-1', steps: [] })]);
    const client = new ModelClient(provider, { pricing });
    const { record } = await client.runStep(runReady(), createBudgetLedger(1_000_000), baseInput(), () => 'x');
    expect(record.status).toBe('repaired');
    expect(record.attempts).toBe(2);
  });

  it('never retries a charged request blindly after an ambiguous timeout', async () => {
    let calls = 0;
    const hanging: ModelProvider = {
      modelId: 'test/hang',
      complete: (req) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          req.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted (timeout)')), { once: true });
        }),
    };
    const hangingClient = new ModelClient(hanging, { pricing, callTimeoutMs: 50 });
    const ledger = createBudgetLedger(1_000_000);
    const dayKey = new Date().toISOString().slice(0, 10);
    const { record, run, ledger: outLedger } = await hangingClient.runStep(runReady(), ledger, baseInput(), () => 'x');
    expect(calls).toBe(1); // exactly one attempt — no blind retry
    expect(record.status).toBe('ambiguous');
    expect(record.flagReason).toMatch(/not retried/);
    expect(run.reservedMicros).toBe(0); // reservation released, nothing spent
    expect(run.spentMicros).toBe(0);
    expect(outLedger.days.get(dayKey)?.reservedMicros ?? 0).toBe(0);
  });

  it('refuses dispatch when the run budget gate denies', async () => {
    const provider = fakeProvider([JSON.stringify({ planId: 'p', steps: [] })]);
    const client = new ModelClient(provider, { pricing });
    const run = { ...runReady(), modelCallsUsed: 8 };
    await expect(client.runStep(run, createBudgetLedger(1_000_000), baseInput(), () => 'x')).rejects.toBeInstanceOf(
      ModelBudgetError,
    );
    expect(provider.calls).toBe(0); // nothing dispatched
  });

  it('never saves chain-of-thought: only summary + observable steps', async () => {
    const provider = fakeProvider([JSON.stringify({ planId: 'p', steps: [{ stepId: 's1', adapter: 'rss' }] })]);
    const client = new ModelClient(provider, { pricing });
    const { record } = await client.runStep(runReady(), createBudgetLedger(1_000_000), baseInput(), () => 'summary here');
    expect(record.decisionSummary).toBe('summary here');
    expect(JSON.stringify(record)).not.toMatch(/chain.of.thought|reasoning/i);
  });
});

describe('createModelClientFromEnv', () => {
  const KEY = 'MODEL_PROVIDER_KEY';
  const saved = process.env[KEY];

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('returns null when the key is absent — runs stay awaiting_provider', () => {
    delete process.env[KEY];
    const client = createModelClientFromEnv(() => {
      throw new Error('must not construct provider without key');
    });
    expect(client).toBeNull();
    // Caller contract: without a client, the run waits; public reads unaffected.
    let run = createRun({ subjectId: 's', subjectName: 'S', subjectKind: 'app' });
    run = transition(run, 'running');
    run = transition(run, 'awaiting_provider', 'MODEL_PROVIDER_KEY absent');
    expect(run.state).toBe('awaiting_provider');
    expect(new ProviderUnavailableError('x')).toBeInstanceOf(Error);
  });

  it('builds a client when the key is present', () => {
    process.env[KEY] = 'test-key';
    const client = createModelClientFromEnv((key) => ({ modelId: `m:${key.length}`, complete: async () => ({ text: '{}', usage: { promptTokens: 0, completionTokens: 0 } }) }));
    expect(client).not.toBeNull();
    expect(client!.modelId).toBe('m:8');
  });
});

describe('citationGateDecision', () => {
  it('an unsupported DATE fails the publication gate', () => {
    const { decision, unsupported } = citationGateDecision([
      { claimId: 'c1', verdict: 'supported', kind: 'other' },
      { claimId: 'c2', verdict: 'unsupported', kind: 'date' },
    ]);
    expect(decision).toBe('fail');
    expect(unsupported).toEqual(['c2']);
  });

  it('unsupported quantity and allegation fail; unsupported context does not', () => {
    expect(citationGateDecision([{ claimId: 'c1', verdict: 'unsupported', kind: 'quantity' }]).decision).toBe('fail');
    expect(citationGateDecision([{ claimId: 'c1', verdict: 'unsupported', kind: 'allegation' }]).decision).toBe('fail');
    expect(citationGateDecision([{ claimId: 'c1', verdict: 'unsupported', kind: 'other' }]).decision).toBe('pass');
    expect(citationGateDecision([{ claimId: 'c1', verdict: 'partial', kind: 'date' }]).decision).toBe('pass');
  });
});

describe('coerceDatePrecision', () => {
  it('approximate dates stay approximate — never manufactures a day from a year', () => {
    expect(coerceDatePrecision('2015', 'day')).toEqual({ value: '2015', precision: 'year' });
    expect(coerceDatePrecision('2015-03', 'day')).toEqual({ value: '2015-03', precision: 'yearMonth' });
    expect(coerceDatePrecision('2015-03-14', 'year')).toEqual({ value: '2015-03-14', precision: 'day' });
  });

  it('null and unparseable input become null, never a guess', () => {
    expect(coerceDatePrecision(null, 'day')).toEqual({ value: null, precision: 'null' });
    expect(coerceDatePrecision('March 2015', 'yearMonth')).toEqual({ value: null, precision: 'null' });
    expect(coerceDatePrecision('sometime in the 90s', 'year')).toEqual({ value: null, precision: 'null' });
  });
});

describe('fake provider spy', () => {
  it('vi is available', () => {
    const fn = vi.fn();
    fn();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
