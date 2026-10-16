import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { getRequestId, getContext } from './context.js';

export type { PinoLogger as Logger };

const SENSITIVE_TOKENS = [
  'password',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
  'seed',
  'mnemonic',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_TOKENS.some((t) => normalized.includes(t));
}

function redactPaths(obj: unknown, seen: WeakSet<object>): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  if (Array.isArray(obj)) return obj.map((v) => redactPaths(v, seen));
  if (obj instanceof Error) {
    return {
      type: obj.name,
      message: obj.message,
      stack: obj.stack,
      ...(redactPaths({ ...(obj as unknown as Record<string, unknown>) }, seen) as Record<string, unknown>),
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    // Only string values are redacted: booleans/numbers/objects under a
    // sensitive-sounding key (e.g. capabilities.token=false) are not secrets.
    out[k] = isSensitiveKey(k) && typeof v === 'string' && v.length > 0 ? '[redacted]' : redactPaths(v, seen);
  }
  return out;
}

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  /** pino destination (tests capture output here) */
  destination?: NodeJS.WritableStream;
}

/**
 * Structured JSON logger. Every line carries service, requestId and trace
 * ids (from async context when present) via a mixin, and never secret
 * values — sensitive keys are redacted by a serializer before output.
 */
export function createLogger(opts: CreateLoggerOptions): PinoLogger {
  const redact = (value: unknown) => redactPaths(value, new WeakSet());
  const options: LoggerOptions = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.service },
    formatters: {
      level: (label) => ({ level: label }),
    },
    mixin: () => {
      const ctx = getContext();
      if (!ctx) return {};
      return { requestId: ctx.requestId, traceId: ctx.traceId, spanId: ctx.spanId };
    },
  };
  const withRedaction: LoggerOptions = {
    ...options,
    hooks: {
      // Redact the merge object of every log call before pino serializes it.
      logMethod(inputArgs, method) {
        const redacted = (inputArgs as unknown[]).map((a) =>
          typeof a === 'object' && a !== null ? redact(a) : a,
        );
        return method.apply(this, redacted as never);
      },
    },
  };
  if (opts.pretty && process.env.NODE_ENV !== 'production') {
    return pino({ ...withRedaction, transport: { target: 'pino-pretty' } });
  }
  return pino(withRedaction, opts.destination);
}

/** Re-exported for unit tests of the redaction rule itself. */
export function redactForLog(value: unknown): unknown {
  return redactPaths(value, new WeakSet());
}

export { getRequestId };
