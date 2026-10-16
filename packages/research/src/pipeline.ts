/**
 * Research run state machine + bounded step orchestration (brief §5, §7).
 *
 * States: queued → running → awaiting_provider → awaiting_review →
 *          completed | failed | cancelled
 *
 * Budgets are reserved BEFORE dispatch so concurrent runs cannot overspend.
 * Caps (15 candidate sources, 8 model calls, 10 minutes per run) are defaults
 * and configurable per run. Monetary ceilings are enforced alongside counts.
 */
import { randomUUID } from 'node:crypto';
import type { SubjectKind } from './providers/types.js';

export type ResearchRunState =
  | 'queued'
  | 'running'
  | 'awaiting_provider'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** The 12 workflow steps from brief §7. */
export const WORKFLOW_STEPS = [
  { n: 1, name: 'discover_candidate', queue: 'discovery' },
  { n: 2, name: 'plan_research', queue: 'discovery' },
  { n: 3, name: 'collect_sources', queue: 'fetch' },
  { n: 4, name: 'extract_facts', queue: 'extract' },
  { n: 5, name: 'detect_changes', queue: 'extract' },
  { n: 6, name: 'propose_status', queue: 'draft' },
  { n: 7, name: 'draft_sections', queue: 'draft' },
  { n: 8, name: 'citation_check', queue: 'review-preflight' },
  { n: 9, name: 'review_package', queue: 'review-preflight' },
  { n: 10, name: 'editorial_decision', queue: 'review-preflight' },
  { n: 11, name: 'publish', queue: 'publish' },
  { n: 12, name: 'schedule_revisit', queue: 'maintenance' },
] as const;

export type WorkflowStepName = (typeof WORKFLOW_STEPS)[number]['name'];

const TRANSITIONS: Record<ResearchRunState, ResearchRunState[]> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting_provider', 'awaiting_review', 'failed', 'cancelled'],
  awaiting_provider: ['running', 'failed', 'cancelled'],
  awaiting_review: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: ResearchRunState, to: ResearchRunState) {
    super(`illegal research-run transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export interface RunCaps {
  maxCandidateSources: number;
  maxModelCalls: number;
  maxMinutes: number;
  /** Monetary ceiling in micro-USD (1_000_000 = $1). */
  maxCostMicros: number;
}

/** Brief §7 suggested initial caps. */
export const DEFAULT_CAPS: RunCaps = {
  maxCandidateSources: 15,
  maxModelCalls: 8,
  maxMinutes: 10,
  maxCostMicros: 500_000, // $0.50 per run default
};

export interface StepRecord {
  step: WorkflowStepName;
  stepNumber: number;
  startedAt: string;
  finishedAt?: string;
  status: 'started' | 'ok' | 'partial' | 'failed' | 'skipped';
  /** Observable summary only — never hidden chain-of-thought. */
  summary?: string;
  costMicros: number;
}

export interface ResearchRun {
  runId: string;
  subjectId: string;
  subjectName: string;
  subjectKind: SubjectKind;
  state: ResearchRunState;
  caps: RunCaps;
  steps: StepRecord[];
  modelCallsUsed: number;
  /** Micro-USD reserved (not yet spent) and spent. */
  reservedMicros: number;
  spentMicros: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  awaitingReason?: string;
  failure?: { code: string; message: string };
  history: Array<{ from: ResearchRunState; to: ResearchRunState; at: string; reason?: string }>;
}

export function createRun(input: {
  subjectId: string;
  subjectName: string;
  subjectKind: SubjectKind;
  caps?: Partial<RunCaps>;
}): ResearchRun {
  const now = new Date().toISOString();
  return {
    runId: `run_${randomUUID()}`,
    subjectId: input.subjectId,
    subjectName: input.subjectName,
    subjectKind: input.subjectKind,
    state: 'queued',
    caps: { ...DEFAULT_CAPS, ...input.caps },
    steps: [],
    modelCallsUsed: 0,
    reservedMicros: 0,
    spentMicros: 0,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

export function transition(run: ResearchRun, to: ResearchRunState, reason?: string): ResearchRun {
  if (!TRANSITIONS[run.state].includes(to)) {
    throw new IllegalTransitionError(run.state, to);
  }
  const now = new Date().toISOString();
  const next: ResearchRun = {
    ...run,
    state: to,
    updatedAt: now,
    history: [...run.history, { from: run.state, to, at: now, reason }],
  };
  if (to === 'running' && !next.startedAt) next.startedAt = now;
  if (to === 'completed' || to === 'failed' || to === 'cancelled') next.finishedAt = now;
  if (to === 'awaiting_provider' || to === 'awaiting_review') next.awaitingReason = reason;
  return next;
}

export function isTerminal(state: ResearchRunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

/** Elapsed minutes since the run started (for the 10-minute cap). */
export function elapsedMinutes(run: ResearchRun, nowMs = Date.now()): number {
  if (!run.startedAt) return 0;
  return (nowMs - Date.parse(run.startedAt)) / 60_000;
}

export function recordStep(
  run: ResearchRun,
  step: WorkflowStepName,
  status: StepRecord['status'],
  summary?: string,
  costMicros = 0,
): ResearchRun {
  const def = WORKFLOW_STEPS.find((s) => s.name === step)!;
  const now = new Date().toISOString();
  const record: StepRecord = {
    step,
    stepNumber: def.n,
    startedAt: now,
    finishedAt: now,
    status,
    summary,
    costMicros,
  };
  return { ...run, steps: [...run.steps, record], updatedAt: now };
}

/* ------------------------------------------------------------------ */
/* Budget reservation (before dispatch)                                */
/* ------------------------------------------------------------------ */

export interface BudgetLedger {
  /** YYYY-MM-DD (UTC) → totals. In production this is a DB row. */
  days: Map<string, { reservedMicros: number; spentMicros: number }>;
  dailyMaxMicros: number;
}

export function createBudgetLedger(dailyMaxMicros: number): BudgetLedger {
  return { days: new Map(), dailyMaxMicros };
}

function dayKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Reserve budget BEFORE dispatching a charged step. Concurrent runs share the
 * ledger, so a reservation that would exceed the daily ceiling fails here —
 * never after the money is spent.
 */
export function reserveBudget(
  ledger: BudgetLedger,
  run: ResearchRun,
  micros: number,
  nowMs = Date.now(),
): { ledger: BudgetLedger; run: ResearchRun } {
  if (micros < 0) throw new BudgetExceededError('cannot reserve negative budget');
  const key = dayKey(nowMs);
  const day = ledger.days.get(key) ?? { reservedMicros: 0, spentMicros: 0 };
  if (day.reservedMicros + day.spentMicros + micros > ledger.dailyMaxMicros) {
    throw new BudgetExceededError(
      `daily budget exceeded: reserving ${micros}µ$ would pass ${ledger.dailyMaxMicros}µ$`,
    );
  }
  if (run.spentMicros + run.reservedMicros + micros > run.caps.maxCostMicros) {
    throw new BudgetExceededError(
      `run cap exceeded: reserving ${micros}µ$ would pass run ceiling ${run.caps.maxCostMicros}µ$`,
    );
  }
  const nextDays = new Map(ledger.days);
  nextDays.set(key, { ...day, reservedMicros: day.reservedMicros + micros });
  return {
    ledger: { ...ledger, days: nextDays },
    run: { ...run, reservedMicros: run.reservedMicros + micros, updatedAt: new Date().toISOString() },
  };
}

/** Settle a reservation into actual spend (or release it when cost is 0). */
export function settleReservation(
  ledger: BudgetLedger,
  run: ResearchRun,
  reservedMicros: number,
  actualMicros: number,
  nowMs = Date.now(),
): { ledger: BudgetLedger; run: ResearchRun } {
  const key = dayKey(nowMs);
  const day = ledger.days.get(key) ?? { reservedMicros: 0, spentMicros: 0 };
  const nextDays = new Map(ledger.days);
  nextDays.set(key, {
    reservedMicros: Math.max(0, day.reservedMicros - reservedMicros),
    spentMicros: day.spentMicros + actualMicros,
  });
  return {
    ledger: { ...ledger, days: nextDays },
    run: {
      ...run,
      reservedMicros: Math.max(0, run.reservedMicros - reservedMicros),
      spentMicros: run.spentMicros + actualMicros,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Gate a model call: count cap AND monetary ceiling, checked pre-dispatch. */
export function canDispatchModelCall(run: ResearchRun, estimatedMicros: number): { ok: boolean; reason?: string } {
  if (run.modelCallsUsed >= run.caps.maxModelCalls) {
    return { ok: false, reason: `model-call count cap reached (${run.caps.maxModelCalls})` };
  }
  if (run.spentMicros + run.reservedMicros + estimatedMicros > run.caps.maxCostMicros) {
    return { ok: false, reason: `run monetary ceiling reached (${run.caps.maxCostMicros}µ$)` };
  }
  if (elapsedMinutes(run) >= run.caps.maxMinutes) {
    return { ok: false, reason: `run time cap reached (${run.caps.maxMinutes} min)` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Circuit breaker                                                     */
/* ------------------------------------------------------------------ */

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxAttempts?: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private halfOpenAttempts = 0;
  constructor(private readonly opts: CircuitBreakerOptions) {}

  get state(): 'closed' | 'open' | 'half_open' {
    return this.stateAt(Date.now());
  }

  /** Clock-injectable state for tests. */
  stateAt(nowMs: number): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed';
    if (nowMs - this.openedAt >= this.opts.cooldownMs) return 'half_open';
    return 'open';
  }

  /** Returns true when a call may proceed. */
  allow(nowMs = Date.now()): boolean {
    if (this.openedAt === null) return true;
    if (nowMs - this.openedAt >= this.opts.cooldownMs) {
      return this.halfOpenAttempts < (this.opts.halfOpenMaxAttempts ?? 1);
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
  }

  recordFailure(nowMs = Date.now()): void {
    if (this.openedAt !== null && nowMs - this.openedAt >= this.opts.cooldownMs) {
      this.halfOpenAttempts += 1;
    }
    this.failures += 1;
    if (this.failures >= this.opts.failureThreshold) {
      this.openedAt = nowMs;
      this.halfOpenAttempts = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Revisit scheduling                                                  */
/* ------------------------------------------------------------------ */

export type MonitorTier = 'active' | 'ordinary' | 'stable_discontinued';

/** Brief §7 cadence: active daily / ordinary weekly / stable-discontinued monthly. */
export function scheduleNextReview(
  tier: MonitorTier,
  fromMs = Date.now(),
  jitterRatio = 0.1,
): string {
  const baseDays = tier === 'active' ? 1 : tier === 'ordinary' ? 7 : 30;
  // Deterministic-ish jitter: small, always positive, bounded by jitterRatio.
  const jitter = (hashJitter(fromMs) * 2 - 1) * jitterRatio;
  const days = baseDays * (1 + jitter);
  // Batching hint: round to the next 6-hour boundary so due work lands in
  // small batches rather than scattered across the day.
  const batchMs = 6 * 3600_000;
  const target = fromMs + days * 86_400_000;
  return new Date(Math.ceil(target / batchMs) * batchMs).toISOString();
}

/** Tiny deterministic PRNG from a seed (mulberry-ish) for jitter. */
function hashJitter(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}
