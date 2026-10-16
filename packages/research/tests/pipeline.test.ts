import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  CircuitBreaker,
  DEFAULT_CAPS,
  IllegalTransitionError,
  WORKFLOW_STEPS,
  canDispatchModelCall,
  createBudgetLedger,
  createRun,
  elapsedMinutes,
  isTerminal,
  recordStep,
  reserveBudget,
  scheduleNextReview,
  settleReservation,
  transition,
} from '../src/pipeline.js';

const subject = { subjectId: 'sub_1', subjectName: 'Test App', subjectKind: 'app' as const };

describe('research run state machine', () => {
  it('starts queued and walks the happy path', () => {
    let run = createRun(subject);
    expect(run.state).toBe('queued');
    run = transition(run, 'running');
    run = transition(run, 'awaiting_review', 'draft ready');
    expect(run.awaitingReason).toBe('draft ready');
    run = transition(run, 'completed');
    expect(run.state).toBe('completed');
    expect(run.finishedAt).toBeDefined();
    expect(isTerminal(run.state)).toBe(true);
  });

  it('supports awaiting_provider and revision loops', () => {
    let run = createRun(subject);
    run = transition(run, 'running');
    run = transition(run, 'awaiting_provider', 'MODEL_PROVIDER_KEY absent');
    run = transition(run, 'running', 'key configured');
    run = transition(run, 'awaiting_review');
    run = transition(run, 'running', 'editor requested changes');
    run = transition(run, 'failed');
    expect(run.state).toBe('failed');
  });

  it('rejects illegal transitions', () => {
    const run = createRun(subject);
    expect(() => transition(run, 'completed')).toThrow(IllegalTransitionError);
    expect(() => transition(run, 'awaiting_review')).toThrow(IllegalTransitionError);
  });

  it('terminal states accept no transitions', () => {
    let run = createRun(subject);
    run = transition(run, 'cancelled');
    expect(() => transition(run, 'running')).toThrow(IllegalTransitionError);
  });

  it('records history with reasons', () => {
    let run = createRun(subject);
    run = transition(run, 'running');
    run = transition(run, 'cancelled', 'user request');
    expect(run.history).toHaveLength(2);
    expect(run.history[1]).toMatchObject({ from: 'running', to: 'cancelled', reason: 'user request' });
  });
});

describe('workflow steps', () => {
  it('defines exactly the 12 brief §7 steps in order', () => {
    expect(WORKFLOW_STEPS).toHaveLength(12);
    expect(WORKFLOW_STEPS[0].name).toBe('discover_candidate');
    expect(WORKFLOW_STEPS[11].name).toBe('schedule_revisit');
    expect(WORKFLOW_STEPS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('records step outcomes with cost', () => {
    let run = createRun(subject);
    run = transition(run, 'running');
    run = recordStep(run, 'collect_sources', 'partial', '2 of 3 providers ok', 1200);
    expect(run.steps[0]).toMatchObject({ stepNumber: 3, status: 'partial', costMicros: 1200 });
  });

  it('enforces the 10-minute default cap via elapsedMinutes', () => {
    let run = createRun(subject);
    run = transition(run, 'running');
    run = { ...run, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
    expect(elapsedMinutes(run)).toBeGreaterThan(10);
    expect(canDispatchModelCall(run, 1).ok).toBe(false);
  });
});

describe('budget reservation', () => {
  it('reserves before dispatch and settles to actual spend', () => {
    const ledger = createBudgetLedger(1_000_000);
    let run = createRun(subject);
    const r1 = reserveBudget(ledger, run, 50_000);
    expect(r1.run.reservedMicros).toBe(50_000);
    const day = r1.ledger.days.get(new Date().toISOString().slice(0, 10))!;
    expect(day.reservedMicros).toBe(50_000);
    const r2 = settleReservation(r1.ledger, r1.run, 50_000, 12_000);
    expect(r2.run.reservedMicros).toBe(0);
    expect(r2.run.spentMicros).toBe(12_000);
  });

  it('concurrent runs cannot overspend the daily ceiling', () => {
    const ledger = createBudgetLedger(100_000);
    const runA = createRun(subject);
    const runB = createRun({ ...subject, subjectId: 'sub_2' });
    const r1 = reserveBudget(ledger, runA, 60_000);
    // A second run reserving 60_000 would exceed the 100_000 daily ceiling.
    expect(() => reserveBudget(r1.ledger, runB, 60_000)).toThrow(BudgetExceededError);
    // But 40_000 still fits.
    const r2 = reserveBudget(r1.ledger, runB, 40_000);
    expect(r2.run.reservedMicros).toBe(40_000);
  });

  it('run-level monetary ceiling is enforced at reservation', () => {
    const ledger = createBudgetLedger(10_000_000);
    const run = createRun({ ...subject, caps: { ...DEFAULT_CAPS, maxCostMicros: 1_000 } });
    expect(() => reserveBudget(ledger, run, 1_001)).toThrow(BudgetExceededError);
  });

  it('model-call count cap gates dispatch', () => {
    const run = { ...createRun(subject), modelCallsUsed: DEFAULT_CAPS.maxModelCalls };
    const gate = canDispatchModelCall(run, 1);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/count cap/);
  });
});

describe('circuit breaker', () => {
  it('opens after the threshold and half-opens after cooldown', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    expect(cb.stateAt(0)).toBe('closed');
    cb.recordFailure(0);
    cb.recordFailure(0);
    expect(cb.allow(0)).toBe(true);
    cb.recordFailure(0);
    expect(cb.stateAt(0)).toBe('open');
    expect(cb.allow(500)).toBe(false);
    expect(cb.allow(1_500)).toBe(true); // half-open
    expect(cb.stateAt(1_500)).toBe('half_open');
    cb.recordSuccess();
    expect(cb.stateAt(1_500)).toBe('closed');
  });
});

describe('revisit scheduling', () => {
  it('active daily / ordinary weekly / stable-discontinued monthly', () => {
    const from = Date.parse('2026-10-16T00:00:00Z');
    const day = 86_400_000;
    const active = Date.parse(scheduleNextReview('active', from));
    const ordinary = Date.parse(scheduleNextReview('ordinary', from));
    const stable = Date.parse(scheduleNextReview('stable_discontinued', from));
    expect(active - from).toBeGreaterThan(0.8 * day);
    expect(active - from).toBeLessThan(1.3 * day);
    expect(ordinary - from).toBeGreaterThan(6 * day);
    expect(ordinary - from).toBeLessThan(8 * day);
    expect(stable - from).toBeGreaterThan(26 * day);
    expect(stable - from).toBeLessThan(34 * day);
  });

  it('is deterministic for the same seed', () => {
    const from = Date.parse('2026-10-16T00:00:00Z');
    expect(scheduleNextReview('ordinary', from)).toBe(scheduleNextReview('ordinary', from));
  });
});
