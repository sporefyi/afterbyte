/**
 * Error taxonomy for job processing (brief §8).
 *
 * - PermanentError: schema / permission / validation failures. These go
 *   straight to failed review and must NEVER be retried.
 * - TransientError: network / provider / rate-limit failures. Retried with
 *   exponential backoff + jitter; honors provider Retry-After.
 */

export class PermanentError extends Error {
  readonly retryable = false as const;
  /** Machine-readable reason surfaced to admin review. */
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'PermanentError';
    this.reason = reason;
  }
}

export class TransientError extends Error {
  readonly retryable = true as const;
  /** Provider Retry-After in milliseconds, when supplied by the provider. */
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TransientError';
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Type guard used by the backoff strategy and processors. */
export function isPermanentError(err: unknown): err is PermanentError {
  return err instanceof PermanentError;
}

export function retryAfterMsOf(err: unknown): number | undefined {
  if (err instanceof TransientError) return err.retryAfterMs;
  if (
    err !== null &&
    typeof err === 'object' &&
    typeof (err as { retryAfterMs?: unknown }).retryAfterMs === 'number'
  ) {
    return (err as { retryAfterMs: number }).retryAfterMs;
  }
  return undefined;
}
