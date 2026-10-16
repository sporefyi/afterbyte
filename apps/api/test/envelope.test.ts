import { describe, it, expect } from 'vitest';
import { success, failure, ERROR_STATUS } from '../src/lib/envelope.js';

describe('envelopes', () => {
  it('builds a success envelope with the brief §12 shape', () => {
    const env = success({ a: 1 }, { requestId: 'r1' });
    expect(env.data).toEqual({ a: 1 });
    expect(env.meta.requestId).toBe('r1');
    expect(env.meta.dataMode).toBe('live');
    expect(env.meta.freshness).toBe('fresh');
    expect(env.meta.nextCursor).toBeNull();
    expect(typeof env.meta.asOf).toBe('string');
  });

  it('propagates nextCursor and dataMode', () => {
    const env = success([], { requestId: 'r1', nextCursor: 'abc', dataMode: 'fixture' });
    expect(env.meta.nextCursor).toBe('abc');
    expect(env.meta.dataMode).toBe('fixture');
  });

  it('builds an error envelope with the brief §12 shape', () => {
    const env = failure('NOT_FOUND', 'gone', 'r2', { fieldErrors: [{ field: 'q', message: 'bad' }] });
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.requestId).toBe('r2');
    expect(env.error.retryable).toBe(false);
    expect(env.error.fieldErrors).toHaveLength(1);
  });

  it('maps error codes to the brief §12 HTTP statuses', () => {
    expect(ERROR_STATUS.VALIDATION_FAILED).toBe(422);
    expect(ERROR_STATUS.UNAUTHORIZED).toBe(401);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_STATUS.VERSION_CONFLICT).toBe(409);
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_STATUS.FEATURE_UNAVAILABLE).toBe(503);
    expect(ERROR_STATUS.PROVIDER_UNAVAILABLE).toBe(503);
    expect(ERROR_STATUS.PROOF_PENDING).toBe(202);
  });
});
