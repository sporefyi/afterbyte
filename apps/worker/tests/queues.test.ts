/** Queue registry: names, deterministic keys, envelope shape. */
import { describe, it, expect } from 'vitest';
import {
  QUEUE_NAMES,
  jobKeys,
  OUTBOX_EVENT_ROUTES,
  PUBLIC_EVENT_TYPES,
} from '../src/queues.js';

describe('QUEUE_NAMES', () => {
  it('contains the 13 brief §8 queues', () => {
    expect([...QUEUE_NAMES]).toEqual([
      'discovery',
      'fetch',
      'extract',
      'draft',
      'review-preflight',
      'publish',
      'anchor-receipt',
      'recheck-receipt',
      'refresh-read-models',
      'render-share-card',
      'reconcile-payment',
      'reconcile-refund',
      'maintenance',
    ]);
  });
});

describe('jobKeys', () => {
  it('are deterministic for the same logical work', () => {
    expect(jobKeys.publish('sub-1', 2)).toBe(jobKeys.publish('sub-1', 2));
    expect(jobKeys.publish('sub-1', 2)).toBe('publish:sub-1:v2');
  });

  it('differ across versions, subjects, and queues', () => {
    expect(jobKeys.publish('sub-1', 2)).not.toBe(jobKeys.publish('sub-1', 3));
    expect(jobKeys.publish('sub-1', 2)).not.toBe(jobKeys.publish('sub-2', 2));
    expect(jobKeys.anchorReceipt('sub-1', 2)).not.toBe(jobKeys.publish('sub-1', 2));
  });

  it('outbox job ids are unique per event', () => {
    expect(jobKeys.outboxEvent('evt-1')).not.toBe(jobKeys.outboxEvent('evt-2'));
  });
});

describe('OUTBOX_EVENT_ROUTES', () => {
  it('routes every queue-bound event type to a known queue', () => {
    for (const queue of Object.values(OUTBOX_EVENT_ROUTES)) {
      expect(QUEUE_NAMES).toContain(queue);
    }
  });

  it('covers the publish-flow follow-ups', () => {
    expect(OUTBOX_EVENT_ROUTES['receipt.anchor.requested']).toBe('anchor-receipt');
    expect(OUTBOX_EVENT_ROUTES['readmodel.refresh.requested']).toBe('refresh-read-models');
    expect(OUTBOX_EVENT_ROUTES['sharecard.render.requested']).toBe('render-share-card');
  });
});

describe('PUBLIC_EVENT_TYPES', () => {
  it('includes the brief §14 SSE types', () => {
    for (const t of [
      'dossier.published',
      'dossier.corrected',
      'dossier.retracted',
      'subject.status_changed',
      'research.started',
      'research.completed',
      'receipt.finalized',
    ]) {
      expect(PUBLIC_EVENT_TYPES.has(t)).toBe(true);
    }
  });
});
