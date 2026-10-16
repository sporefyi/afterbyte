import { describe, it, expect } from 'vitest';
import { resolveCursor, eventsAfter, formatResyncEvent, type EventRecord } from '../src/sse.js';

const e1: EventRecord = {
  eventId: 'e1', sequenceId: '1', eventType: 'dossier.published',
  occurredAt: new Date().toISOString(), subjectId: 's1', dossierVersion: 1, aggregateRevision: 1, payload: {},
};
const e2: EventRecord = {
  eventId: 'e2', sequenceId: '2', eventType: 'receipt.finalized',
  occurredAt: new Date().toISOString(), subjectId: 's1', dossierVersion: 1, aggregateRevision: 2, payload: {},
};

describe('sse cursor resolution', () => {
  it('starts from zero with no Last-Event-ID', () => {
    expect(resolveCursor(undefined, [e1, e2])).toEqual({ kind: 'ok', afterSequenceId: '0' });
  });

  it('resumes after a known event id', () => {
    const c = resolveCursor('e1', [e1, e2]);
    expect(c).toEqual({ kind: 'ok', afterSequenceId: '1' });
    expect(eventsAfter([e1, e2], '1').map((e) => e.eventId)).toEqual(['e2']);
  });

  it('emits resync_required for unknown or expired cursors', () => {
    expect(resolveCursor('unknown-id', [e1, e2]).kind).toBe('resync_required');
    const old: EventRecord = { ...e1, occurredAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() };
    expect(resolveCursor('e1', [old]).kind).toBe('resync_required');
    expect(formatResyncEvent()).toContain('resync_required');
  });

  it('compares bigint sequence ids correctly', () => {
    const big: EventRecord = { ...e2, sequenceId: '9007199254740993' };
    expect(eventsAfter([e1, big], '9007199254740992')).toHaveLength(1);
  });
});
