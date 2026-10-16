/** Minimal structured logger. The observability lane owns OTel; the worker
 * only needs JSON lines on stdout with trace correlation. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function write(level: LogLevel, msg: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

class StdLogger implements Logger {
  constructor(private readonly base: Record<string, unknown> = {}) {}
  debug(msg: string, fields: Record<string, unknown> = {}) {
    if (process.env.LOG_LEVEL === 'debug') write('debug', msg, { ...this.base, ...fields });
  }
  info(msg: string, fields: Record<string, unknown> = {}) {
    write('info', msg, { ...this.base, ...fields });
  }
  warn(msg: string, fields: Record<string, unknown> = {}) {
    write('warn', msg, { ...this.base, ...fields });
  }
  error(msg: string, fields: Record<string, unknown> = {}) {
    write('error', msg, { ...this.base, ...fields });
  }
  child(fields: Record<string, unknown>): Logger {
    return new StdLogger({ ...this.base, ...fields });
  }
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  return new StdLogger({ service: 'afterbyte-worker', ...base });
}
