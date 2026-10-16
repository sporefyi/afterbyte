/**
 * Public event stream (brief §14).
 *
 * - SSE of sanitized published events; heartbeats every 20s.
 * - Reconnect supports Last-Event-ID (header or ?lastEventId=).
 * - Events are retained 7 days; a cursor older than retention emits
 *   `resync_required` and the frontend reloads canonical state.
 * - Delivery is at-least-once; consumers deduplicate by eventId and ignore
 *   older aggregate revisions.
 * - Personal and admin events ride separate authorized routes
 *   (/events/me/stream, /admin/events/stream) — never the public stream.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ActivityEvent, PublicEventType } from './services/store.js';

export const HEARTBEAT_MS = 20_000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface EventRecord {
  eventId: string;
  sequenceId: string;
  eventType: PublicEventType;
  occurredAt: string;
  subjectId: string;
  dossierVersion: number | null;
  aggregateRevision: number;
  payload: Record<string, unknown>;
}

export function toEventRecord(e: ActivityEvent): EventRecord {
  return { ...e };
}

export type EventCursor =
  | { kind: 'ok'; afterSequenceId: string }
  | { kind: 'resync_required' };

/** Resolve the reconnect cursor: unknown/too-old -> resync_required. */
export function resolveCursor(
  lastEventId: string | undefined,
  events: EventRecord[],
  nowMs: number = Date.now(),
): EventCursor {
  if (!lastEventId) return { kind: 'ok', afterSequenceId: '0' };
  const found = events.find((e) => e.eventId === lastEventId);
  if (!found) {
    // Unknown event id: if we have any retained events and the id is not
    // among them, the cursor is older than retention -> resync.
    return events.length > 0 ? { kind: 'resync_required' } : { kind: 'ok', afterSequenceId: '0' };
  }
  const age = nowMs - Date.parse(found.occurredAt);
  if (age > RETENTION_MS) return { kind: 'resync_required' };
  return { kind: 'ok', afterSequenceId: found.sequenceId };
}

export function eventsAfter(events: EventRecord[], afterSequenceId: string): EventRecord[] {
  return events
    .filter((e) => BigInt(e.sequenceId) > BigInt(afterSequenceId))
    .sort((a, b) => (BigInt(a.sequenceId) < BigInt(b.sequenceId) ? -1 : 1));
}

function formatEvent(e: EventRecord): string {
  return `id: ${e.eventId}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e)}\n\n`;
}

/**
 * Attach an SSE stream to the reply. Returns a handle the route uses to
 * stop the stream on client disconnect. Events are pushed via `publish()`.
 */
export function attachSseStream(
  _request: FastifyRequest,
  reply: FastifyReply,
  opts: { heartbeatMs?: number } = {},
): { publish: (e: EventRecord) => void; close: () => void } {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const raw = reply.raw as unknown as { write: (s: string) => void; end: () => void };
  let closed = false;

  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      raw.write(': heartbeat\n\n');
    } catch {
      close();
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      raw.end();
    } catch {
      /* already gone */
    }
  };

  _request.raw.on('close', close);

  return {
    publish: (e: EventRecord) => {
      if (closed) return;
      try {
        raw.write(formatEvent(e));
      } catch {
        close();
      }
    },
    close,
  };
}

export function formatResyncEvent(): string {
  return `event: resync_required\ndata: ${JSON.stringify({ reason: 'cursor older than retention; reload canonical state' })}\n\n`;
}
