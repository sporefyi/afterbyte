/**
 * Lifecycle evaluation under the versioned policy
 * (policy/lifecycle-policy.v1.json, brief §5).
 *
 * Hard guarantees:
 * - A single HTTP failure, quiet repo, or absent post NEVER sets discontinued.
 * - Missing data is not negative evidence.
 * - `uncertain` is the default when evidence is thin or conflicting.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubjectKind } from './providers/types.js';

export type LifecycleStatus = 'active' | 'dormant' | 'discontinued' | 'revived' | 'uncertain';

export interface EvidenceSignal {
  /** Machine signal type, e.g. "explicit_closure_statement". */
  type: string;
  description: string;
  /** ISO-8601 when the signal was observed. */
  observedAt: string;
  /** Snapshot id backing this signal. */
  snapshotId?: string;
  strength: 'strong' | 'moderate' | 'weak';
}

export interface LifecycleEvaluationInput {
  subjectKind: SubjectKind;
  signals: EvidenceSignal[];
  /** Gaps in coverage that must not be read as negative evidence. */
  coverageGaps: string[];
  /** Explicit closure claim when one exists. */
  explicitClosure?: { description: string; observedAt: string; snapshotId?: string };
  /** Documented return after dormant/discontinued. */
  revivalEvidence?: { description: string; observedAt: string; byOriginalOwners: boolean; snapshotId?: string };
  currentStatus?: LifecycleStatus;
}

export interface LifecycleDecision {
  proposedStatus: LifecycleStatus;
  /** 1–2 sentence reason. */
  reason: string;
  /** Policy rules applied, e.g. "app.discontinued.requires>=3-signal-types". */
  rulesApplied: string[];
  supportingSignalTypes: string[];
  confidence: 'strong' | 'moderate' | 'limited';
  needsHumanReview: boolean;
  policyVersion: string;
}

export interface LifecyclePolicy {
  policyVersion: string;
  kinds: Record<SubjectKind, KindPolicy>;
  revived: {
    requiresDocumentedReturn: boolean;
    minPriorInactiveDays: number;
    noteOriginalVsSuccessor: boolean;
  };
  reviewCadenceDays: Record<LifecycleStatus, number>;
  tieBreak: string;
}

export interface KindPolicy {
  dormantWindowDays: number;
  discontinuedWindowDays: number;
  minSignalTypesForDiscontinued: number;
  /** Signal types that count toward the discontinued threshold. */
  discontinuedSignalTypes: string[];
  explicitClosureBeatsSilence: boolean;
  /** Example of evidence insufficient on its own. */
  insufficientAloneExample: string;
}

const POLICY_VERSION = 'lifecycle-policy.v1';

function policyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ or src/ → package root → policy/
  const root = here.endsWith('/dist') || here.endsWith('\\dist') ? join(here, '..') : join(here, '..');
  return join(root, 'policy', `${POLICY_VERSION}.json`);
}

let cached: LifecyclePolicy | null = null;

export function loadLifecyclePolicy(): LifecyclePolicy {
  if (cached) return cached;
  const raw = readFileSync(policyPath(), 'utf8');
  const parsed = JSON.parse(raw) as LifecyclePolicy;
  if (parsed.policyVersion !== POLICY_VERSION) {
    throw new Error(`lifecycle policy version mismatch: ${parsed.policyVersion}`);
  }
  cached = parsed;
  return parsed;
}

/** For tests: inject a policy without touching the filesystem. */
export function setLifecyclePolicyForTests(policy: LifecyclePolicy): void {
  cached = policy;
}

function daysBetween(aMs: number, bMs: number): number {
  return Math.abs(aMs - bMs) / 86_400_000;
}

/**
 * Evaluate lifecycle status. Pure function of signals + policy.
 * Never invents evidence; prefers `uncertain` when the bar is not met.
 */
export function evaluateLifecycle(input: LifecycleEvaluationInput, nowMs = Date.now()): LifecycleDecision {
  const policy = loadLifecyclePolicy();
  const kindPolicy = policy.kinds[input.subjectKind];
  const rulesApplied: string[] = [`policy:${policy.policyVersion}`, `kind:${input.subjectKind}`];
  const distinctTypes = [...new Set(input.signals.map((s) => s.type))];

  // 1) Revival beats everything when documented.
  if (input.revivalEvidence) {
    rulesApplied.push('revived:documented-return');
    return {
      proposedStatus: 'revived',
      reason: `Documented return observed: ${input.revivalEvidence.description} (${input.revivalEvidence.byOriginalOwners ? 'original owners' : 'successor'}).`,
      rulesApplied,
      supportingSignalTypes: ['revival'],
      confidence: input.revivalEvidence.snapshotId ? 'strong' : 'moderate',
      needsHumanReview: !input.revivalEvidence.byOriginalOwners,
      policyVersion: policy.policyVersion,
    };
  }

  // 2) Explicit closure is decisive when the policy says so for the kind.
  if (input.explicitClosure && kindPolicy.explicitClosureBeatsSilence) {
    rulesApplied.push(`${input.subjectKind}.discontinued:explicit-closure`);
    return {
      proposedStatus: 'discontinued',
      reason: `Explicit closure statement: ${input.explicitClosure.description}.`,
      rulesApplied,
      supportingSignalTypes: ['explicit_closure_statement'],
      confidence: input.explicitClosure.snapshotId ? 'strong' : 'moderate',
      needsHumanReview: false,
      policyVersion: policy.policyVersion,
    };
  }

  const strongOrModerate = input.signals.filter((s) => s.strength !== 'weak');
  const qualifyingTypes = distinctTypes.filter((t) => kindPolicy.discontinuedSignalTypes.includes(t));
  const windowStart = nowMs - kindPolicy.discontinuedWindowDays * 86_400_000;
  const recentQualifying = input.signals.filter(
    (s) => kindPolicy.discontinuedSignalTypes.includes(s.type) && Date.parse(s.observedAt) >= windowStart,
  );
  const oldestSignalMs = Math.min(...input.signals.map((s) => Date.parse(s.observedAt)), nowMs);
  const evidenceAgeDays = daysBetween(oldestSignalMs, nowMs);

  // 3) Discontinued: enough independent signal types, sustained over the
  //    window, with evidence old enough to rule out a blip.
  if (
    qualifyingTypes.length >= kindPolicy.minSignalTypesForDiscontinued &&
    recentQualifying.length >= kindPolicy.minSignalTypesForDiscontinued &&
    evidenceAgeDays >= kindPolicy.discontinuedWindowDays * 0.5 &&
    strongOrModerate.length > 0
  ) {
    rulesApplied.push(
      `${input.subjectKind}.discontinued:>=${kindPolicy.minSignalTypesForDiscontinued}-signal-types-over-${kindPolicy.discontinuedWindowDays}d`,
    );
    return {
      proposedStatus: 'discontinued',
      reason: `Cessation supported by ${qualifyingTypes.length} independent signal types over ~${Math.round(evidenceAgeDays)} days: ${qualifyingTypes.join(', ')}.`,
      rulesApplied,
      supportingSignalTypes: qualifyingTypes,
      confidence: qualifyingTypes.length >= kindPolicy.minSignalTypesForDiscontinued + 1 ? 'strong' : 'moderate',
      needsHumanReview: false,
      policyVersion: policy.policyVersion,
    };
  }

  // 4) Dormant: inactivity signals sustained over the dormant window, but the
  //    discontinued bar is not met.
  const dormantStart = nowMs - kindPolicy.dormantWindowDays * 86_400_000;
  const inactivitySignals = input.signals.filter(
    (s) => /inactiv|silence|quiet|no_|stale/i.test(s.type) && Date.parse(s.observedAt) >= dormantStart,
  );
  if (inactivitySignals.length >= 2 && evidenceAgeDays >= kindPolicy.dormantWindowDays * 0.5) {
    rulesApplied.push(`${input.subjectKind}.dormant:inactivity-over-${kindPolicy.dormantWindowDays}d`);
    return {
      proposedStatus: 'dormant',
      reason: `Reliable inactivity over ~${Math.round(evidenceAgeDays)} days (${[...new Set(inactivitySignals.map((s) => s.type))].join(', ')}); discontinued threshold not met.`,
      rulesApplied,
      supportingSignalTypes: [...new Set(inactivitySignals.map((s) => s.type))],
      confidence: 'moderate',
      needsHumanReview: false,
      policyVersion: policy.policyVersion,
    };
  }

  // 5) Active: recent positive operation evidence.
  const activeSignals = input.signals.filter((s) => /operating|release|active|update|post/i.test(s.type));
  const recentActive = activeSignals.filter((s) => Date.parse(s.observedAt) >= nowMs - 90 * 86_400_000);
  if (recentActive.length > 0 && input.signals.every((s) => !/closure|shutdown|archived/i.test(s.type) || s.strength === 'weak')) {
    rulesApplied.push('active:recent-operation-evidence');
    return {
      proposedStatus: 'active',
      reason: `Recent evidence of continued operation: ${recentActive[0].description}.`,
      rulesApplied,
      supportingSignalTypes: [...new Set(recentActive.map((s) => s.type))],
      confidence: recentActive.some((s) => s.strength === 'strong') ? 'strong' : 'moderate',
      needsHumanReview: false,
      policyVersion: policy.policyVersion,
    };
  }

  // 6) Default: uncertain. Thin, conflicting, or gap-ridden evidence.
  const conflicting =
    activeSignals.length > 0 &&
    input.signals.some((s) => /closure|shutdown|archived|inactiv/i.test(s.type));
  rulesApplied.push(conflicting ? 'uncertain:conflicting-signals' : 'uncertain:insufficient-evidence');
  return {
    proposedStatus: 'uncertain',
    reason: conflicting
      ? 'Signals conflict (both activity and cessation indicators present); cannot resolve without more evidence.'
      : `Insufficient evidence to support another status (${input.signals.length} signal(s), ${input.coverageGaps.length} coverage gap(s)). Missing data is not negative evidence.`,
    rulesApplied,
    supportingSignalTypes: distinctTypes,
    confidence: 'limited',
    needsHumanReview: true,
    policyVersion: policy.policyVersion,
  };
}

/** Next review date for a status under the policy cadence. */
export function nextReviewDate(status: LifecycleStatus, fromMs = Date.now()): string {
  const policy = loadLifecyclePolicy();
  const days = policy.reviewCadenceDays[status] ?? 30;
  return new Date(fromMs + days * 86_400_000).toISOString();
}
