/** Backoff math: exponential growth, jitter bounds, ceiling, Retry-After. */
import { describe, it, expect } from 'vitest';
import {
  computeBackoffDelayMs,
  afterbyteBackoffStrategy,
  MAX_ATTEMPTS,
  BASE_BACKOFF_MS,
  JITTER_FRACTION,
  MAX_BACKOFF_MS,
} from '../src/backoff.js';
import { TransientError } from '../src/errors.js';

describe('computeBackoffDelayMs', () => {
  it('grows exponentially with attempts made', () => {
    const noJitter = { jitterFraction: 0, random: () => 0.5 };
    expect(computeBackoffDelayMs(0, noJitter)).toBe(BASE_BACKOFF_MS);
    expect(computeBackoffDelayMs(1, noJitter)).toBe(BASE_BACKOFF_MS * 2);
    expect(computeBackoffDelayMs(2, noJitter)).toBe(BASE_BACKOFF_MS * 4);
  });

  it('stays within the jitter band', () => {
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffDelayMs(1);
      const base = BASE_BACKOFF_MS * 2;
      expect(d).toBeGreaterThanOrEqual(Math.round(base * (1 - JITTER_FRACTION)));
      expect(d).toBeLessThanOrEqual(Math.round(base * (1 + JITTER_FRACTION)));
    }
  });

  it('is capped at MAX_BACKOFF_MS', () => {
    const d = computeBackoffDelayMs(100, { jitterFraction: 0, random: () => 0.5 });
    expect(d).toBe(MAX_BACKOFF_MS);
  });

  it('is deterministic with an injected RNG', () => {
    const a = computeBackoffDelayMs(1, { random: () => 0.123 });
    const b = computeBackoffDelayMs(1, { random: () => 0.123 });
    expect(a).toBe(b);
  });

  it('never goes negative', () => {
    const d = computeBackoffDelayMs(0, { jitterFraction: 0.99, random: () => 0 });
    expect(d).toBeGreaterThanOrEqual(0);
  });
});

describe('afterbyteBackoffStrategy', () => {
  it('honors provider Retry-After from the thrown TransientError', () => {
    const err = new TransientError('rate limited', 42_000);
    const d = afterbyteBackoffStrategy(0, 'custom', err, { data: {} });
    expect(d).toBe(42_000);
  });

  it('honors retryAfterMs stashed on job data (survives serialization)', () => {
    const d = afterbyteBackoffStrategy(0, 'custom', new Error('boom'), {
      data: { retryAfterMs: 7_500 },
    });
    expect(d).toBe(7_500);
  });

  it('falls back to exponential backoff with jitter', () => {
    const d = afterbyteBackoffStrategy(1, 'custom', new Error('boom'), { data: {} });
    const base = BASE_BACKOFF_MS * 2;
    expect(d).toBeGreaterThanOrEqual(Math.round(base * (1 - JITTER_FRACTION)));
    expect(d).toBeLessThanOrEqual(Math.round(base * (1 + JITTER_FRACTION)));
  });

  it('caps a huge Retry-After at MAX_BACKOFF_MS', () => {
    const err = new TransientError('slow down', 10_000_000);
    const d = afterbyteBackoffStrategy(0, 'custom', err, { data: {} });
    expect(d).toBe(MAX_BACKOFF_MS);
  });
});

describe('retry policy constants', () => {
  it('uses three attempts', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
