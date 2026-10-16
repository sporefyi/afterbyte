import { describe, it, expect } from 'vitest';
import { parseTraceparent, formatTraceparent, newTraceContext, childSpanContext } from '../src/trace.js';
import { buildLiveness, buildReadiness } from '../src/health.js';
import { createLogger } from '../src/logger.js';
import { runWithContext } from '../src/context.js';

describe('trace propagation', () => {
  it('round-trips W3C traceparent headers', () => {
    const ctx = newTraceContext();
    const header = formatTraceparent(ctx);
    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const parsed = parseTraceparent(header);
    expect(parsed!.traceId).toBe(ctx.traceId);
    expect(parsed!.spanId).toBe(ctx.spanId);
  });

  it('rejects malformed traceparent values', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-1234567890abcdef-01')).toBeNull();
  });

  it('derives child spans under the same trace', () => {
    const parent = newTraceContext();
    const child = childSpanContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
  });
});

describe('health probes', () => {
  it('liveness carries no dependency checks', () => {
    const live = buildLiveness('0.1.0', 42);
    expect(live.status).toBe('live');
    expect(live.uptimeSeconds).toBe(42);
  });

  it('readiness fails only on the database check', () => {
    const notReady = buildReadiness(
      [
        { name: 'database', status: 'down' },
        { name: 'redis', status: 'degraded' },
      ],
      '0.1.0',
      1,
    );
    expect(notReady.status).toBe('not_ready');
    const ready = buildReadiness(
      [
        { name: 'database', status: 'ok' },
        { name: 'redis', status: 'degraded' },
      ],
      '0.1.0',
      1,
    );
    expect(ready.status).toBe('ready');
  });
});

describe('logger', () => {
  it('redacts sensitive keys, never logs secrets', async () => {
    const { Writable } = await import('node:stream');
    const chunks: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ service: 'test', level: 'info', destination: dest });
    runWithContext({ requestId: 'req-123' }, () => {
      log.info({ apiKey: 'sk-live-secret', sessionSecret: 'shh', nested: { password: 'pw' }, ok: 'fine' }, 'msg');
    });
    await new Promise((r) => setImmediate(r));
    const line = JSON.parse(chunks.join(''));
    expect(line.apiKey).toBe('[redacted]');
    expect(line.sessionSecret).toBe('[redacted]');
    expect(line.nested.password).toBe('[redacted]');
    expect(line.ok).toBe('fine');
    expect(line.requestId).toBe('req-123');
    expect(line.service).toBe('test');
    expect(JSON.stringify(line)).not.toContain('sk-live-secret');
  });
});
