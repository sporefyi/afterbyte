/**
 * Response envelopes per brief §12. Every JSON response from the API uses one
 * of these shapes so the frontend contract is uniform.
 */

export type DataMode = 'live' | 'cached' | 'fixture';
export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface EnvelopeMeta {
  requestId: string;
  asOf: string; // ISO-8601
  dataMode: DataMode;
  freshness: Freshness;
  nextCursor: string | null;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: EnvelopeMeta;
}

export interface FieldError {
  field: string;
  message: string;
}

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CSRF_FAILED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'RATE_LIMITED'
  | 'FEATURE_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'PAYMENT_NOT_FINALIZED'
  | 'PAYMENT_MISMATCH'
  | 'PROOF_PENDING'
  | 'CHALLENGE_EXPIRED'
  | 'INTERNAL_ERROR';

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
    fieldErrors: FieldError[];
  };
}

export interface MetaInput {
  requestId: string;
  dataMode?: DataMode;
  freshness?: Freshness;
  nextCursor?: string | null;
  asOf?: Date;
}

export function makeMeta(input: MetaInput): EnvelopeMeta {
  return {
    requestId: input.requestId,
    asOf: (input.asOf ?? new Date()).toISOString(),
    dataMode: input.dataMode ?? 'live',
    freshness: input.freshness ?? 'fresh',
    nextCursor: input.nextCursor ?? null,
  };
}

export function success<T>(data: T, meta: MetaInput): SuccessEnvelope<T> {
  return { data, meta: makeMeta(meta) };
}

export function failure(
  code: ErrorCode,
  message: string,
  requestId: string,
  opts: { retryable?: boolean; fieldErrors?: FieldError[] } = {},
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      retryable: opts.retryable ?? false,
      fieldErrors: opts.fieldErrors ?? [],
    },
  };
}

/** HTTP status mapping for each error code (brief §12). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  FEATURE_UNAVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 503,
  PAYMENT_NOT_FINALIZED: 409,
  PAYMENT_MISMATCH: 409,
  PROOF_PENDING: 202,
  CHALLENGE_EXPIRED: 401,
  INTERNAL_ERROR: 500,
};
