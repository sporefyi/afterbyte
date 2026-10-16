import { describe, expect, it } from 'vitest';
import {
  evaluateLifecycle,
  loadLifecyclePolicy,
  nextReviewDate,
  setLifecyclePolicyForTests,
  type EvidenceSignal,
} from '../src/lifecycle.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const sig = (type: string, d: number, strength: EvidenceSignal['strength'] = 'moderate'): EvidenceSignal => ({
  type,
  description: `${type} observed`,
  observedAt: daysAgo(d),
  snapshotId: `snap_${type}`,
  strength,
});

describe('lifecycle policy', () => {
  it('loads the versioned v1 policy with all 7 subject kinds', () => {
    const p = loadLifecyclePolicy();
    expect(p.policyVersion).toBe('lifecycle-policy.v1');
    for (const k of ['app', 'website', 'game', 'meme', 'community', 'crypto_project', 'other'] as const) {
      expect(p.kinds[k]).toBeDefined();
      expect(p.kinds[k].minSignalTypesForDiscontinued).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('evaluateLifecycle', () => {
  it('a single HTTP outage is NOT discontinued — it is uncertain', () => {
    const d = evaluateLifecycle(
      {
        subjectKind: 'website',
        signals: [sig('http_fetch_failed', 1, 'weak')],
        coverageGaps: ['could not reach origin server'],
      },
      NOW,
    );
    expect(d.proposedStatus).toBe('uncertain');
    expect(d.proposedStatus).not.toBe('discontinued');
    expect(d.needsHumanReview).toBe(true);
  });

  it('a quiet repo alone is NOT discontinued', () => {
    const d = evaluateLifecycle(
      { subjectKind: 'app', signals: [sig('no_release_180_days', 200)], coverageGaps: [] },
      NOW,
    );
    expect(d.proposedStatus).not.toBe('discontinued');
  });

  it('an absent social post alone is NOT discontinued', () => {
    const d = evaluateLifecycle(
      { subjectKind: 'community', signals: [sig('social_silence_30_days', 30, 'weak')], coverageGaps: [] },
      NOW,
    );
    expect(d.proposedStatus).not.toBe('discontinued');
  });

  it('an explicit closure statement sets discontinued for an app', () => {
    const d = evaluateLifecycle(
      {
        subjectKind: 'app',
        signals: [],
        coverageGaps: [],
        explicitClosure: {
          description: 'Founder announced shutdown on the company blog.',
          observedAt: daysAgo(10),
          snapshotId: 'snap_blog',
        },
      },
      NOW,
    );
    expect(d.proposedStatus).toBe('discontinued');
    expect(d.rulesApplied.join(' ')).toMatch(/explicit-closure/);
  });

  it('three independent sustained signals set discontinued for a website', () => {
    const d = evaluateLifecycle(
      {
        subjectKind: 'website',
        signals: [
          sig('domain_expired_or_parked', 300, 'strong'),
          sig('dns_inactive_120_days', 200, 'moderate'),
          sig('no_content_update_180_days', 250, 'moderate'),
        ],
        coverageGaps: [],
      },
      NOW,
    );
    expect(d.proposedStatus).toBe('discontinued');
    expect(d.supportingSignalTypes).toHaveLength(3);
  });

  it('sustained inactivity below the discontinued bar is dormant', () => {
    const d = evaluateLifecycle(
      {
        subjectKind: 'website',
        signals: [sig('no_content_update_180_days', 100), sig('social_silence_200_days', 110)],
        coverageGaps: [],
      },
      NOW,
    );
    expect(d.proposedStatus).toBe('dormant');
  });

  it('recent operation evidence is active', () => {
    const d = evaluateLifecycle(
      { subjectKind: 'app', signals: [sig('operating_evidence', 5, 'strong')], coverageGaps: [] },
      NOW,
    );
    expect(d.proposedStatus).toBe('active');
  });

  it('documented revival beats a prior discontinued bar', () => {
    const d = evaluateLifecycle(
      {
        subjectKind: 'game',
        signals: [sig('no_patch_270_days', 400), sig('store_delisting', 380), sig('studio_closure', 370)],
        coverageGaps: [],
        revivalEvidence: {
          description: 'New patch 2.0 released with official announcement.',
          observedAt: daysAgo(3),
          byOriginalOwners: true,
          snapshotId: 'snap_patch',
        },
      },
      NOW,
    );
    expect(d.proposedStatus).toBe('revived');
  });

  it('conflicting signals default to uncertain with human review', () => {
    const d = evaluateLifecycle(
      {
        subjectKind: 'app',
        signals: [sig('operating_evidence', 5, 'moderate'), sig('explicit_closure_statement', 10, 'moderate')],
        coverageGaps: ['app store listing status unknown'],
      },
      NOW,
    );
    expect(d.proposedStatus).toBe('uncertain');
    expect(d.needsHumanReview).toBe(true);
  });

  it('every decision cites the policy version', () => {
    const d = evaluateLifecycle({ subjectKind: 'meme', signals: [], coverageGaps: ['no coverage'] }, NOW);
    expect(d.policyVersion).toBe('lifecycle-policy.v1');
    expect(d.proposedStatus).toBe('uncertain');
  });

  it('setLifecyclePolicyForTests overrides the file policy', () => {
    const file = loadLifecyclePolicy();
    const clone = JSON.parse(JSON.stringify(file));
    clone.kinds.app.explicitClosureBeatsSilence = false;
    setLifecyclePolicyForTests(clone);
    const d = evaluateLifecycle(
      {
        subjectKind: 'app',
        signals: [],
        coverageGaps: [],
        explicitClosure: { description: 'x', observedAt: daysAgo(1) },
      },
      NOW,
    );
    // With the override, explicit closure no longer short-circuits.
    expect(d.proposedStatus).not.toBe('discontinued');
    setLifecyclePolicyForTests(file);
  });
});

describe('nextReviewDate', () => {
  it('follows the policy cadence', () => {
    expect(Date.parse(nextReviewDate('active', NOW)) - NOW).toBe(30 * 86_400_000);
    expect(Date.parse(nextReviewDate('discontinued', NOW)) - NOW).toBe(120 * 86_400_000);
  });
});
