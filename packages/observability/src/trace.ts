import { randomBytes } from 'node:crypto';

/**
 * OTel-compatible W3C trace context propagation helpers (traceparent /
 * tracestate). No OTel SDK dependency — these parse and emit the standard
 * headers so any OTel collector or downstream service can correlate.
 */

export interface TraceContext {
  traceId: string; // 32 lowercase hex
  spanId: string; // 16 lowercase hex
  sampled: boolean;
  traceState?: string;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(header: string | undefined): TraceContext | null {
  if (!header) return null;
  const m = header.trim().toLowerCase().match(TRACEPARENT_RE);
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (version === 'ff' || traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return {
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & 0x01) === 1,
  };
}

export function formatTraceparent(ctx: TraceContext): string {
  const flags = ctx.sampled ? '01' : '00';
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

export function newTraceContext(sampled = true): TraceContext {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    sampled,
  };
}

export function childSpanContext(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: randomBytes(8).toString('hex'), sampled: parent.sampled };
}
