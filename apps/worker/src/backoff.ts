/**
 * Retry/backoff policy (brief §8):
 * three attempts, exponential backoff with jitter, provider Retry-After honored.
 *
 * Pure functions here are unit-tested in tests/backoff.test.ts. The BullMQ
 * custom backoff strategy at the bottom reads the in-process error (or a
 * `retryAfterMs` hint stashed on job data, which survives serialization).
 */

import { retryAfterMsOf } from './errors.js';

export const MAX_ATTEMPTS = 3;
/** Base delay for attempt N (0-based attemptsMade): base * 2^attemptsMade. */
export const BASE_BACKOFF_MS = 5_000;
/** Symmetric jitter fraction: delay *= 1 ± JITTER_FRACTION. */
export const JITTER_FRACTION = 0.25;
/** Absolute ceiling so a misbehaving provider can't schedule absurd delays. */
export const MAX_BACKOFF_MS = 15 * 60_000;

export interface BackoffOptions {
  baseMs?: number;
  jitterFraction?: number;
  maxMs?: number;
  /** Injected RNG for deterministic tests. Defaults to Math.random. */
  random?: () => number;
}

/**
 * Compute the delay before the next attempt.
 * @param attemptsMade number of attempts already consumed (BullMQ semantics).
 */
export function computeBackoffDelayMs(
  attemptsMade: number,
  opts: BackoffOptions = {},
): number {
  const baseMs = opts.baseMs ?? BASE_BACKOFF_MS;
  const jitterFraction = opts.jitterFraction ?? JITTER_FRACTION;
  const maxMs = opts.maxMs ?? MAX_BACKOFF_MS;
  const random = opts.random ?? Math.random;

  const exponential = baseMs * 2 ** attemptsMade;
  // Symmetric jitter: factor in [1 - f, 1 + f].
  const factor = 1 + (random() * 2 - 1) * jitterFraction;
  const delay = Math.round(exponential * factor);
  return Math.min(Math.max(delay, 0), maxMs);
}

/**
 * BullMQ custom backoff strategy. Honors provider Retry-After first
 * (from the thrown TransientError or job.data.retryAfterMs), else exponential
 * backoff with jitter. Parameter types match BullMQ's BackoffStrategy
 * (all optional after attemptsMade).
 */
export function afterbyteBackoffStrategy(
  attemptsMade: number,
  _type?: string,
  err?: Error,
  job?: { data?: { retryAfterMs?: unknown } },
): number {
  const retryAfter =
    retryAfterMsOf(err) ??
    (typeof job?.data?.retryAfterMs === 'number' ? job.data.retryAfterMs : undefined);
  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(Math.round(retryAfter), MAX_BACKOFF_MS);
  }
  return computeBackoffDelayMs(attemptsMade);
}

/** BullMQ job default options shared by every queue. */
export function defaultJobOptions(jobId: string) {
  return {
    jobId,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'custom' as const },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  };
}
