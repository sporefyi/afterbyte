import { AsyncLocalStorage } from 'node:async_hooks';

/** Request-scoped correlation context shared by logger and trace helpers. */
export interface CorrelationContext {
  requestId: string;
  traceId?: string;
  spanId?: string;
}

const als = new AsyncLocalStorage<CorrelationContext>();

export function runWithContext<T>(ctx: CorrelationContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getContext(): CorrelationContext | undefined {
  return als.getStore();
}

export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
