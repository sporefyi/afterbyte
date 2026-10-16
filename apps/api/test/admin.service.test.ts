import { describe, it, expect } from 'vitest';
import {
  AdminStore,
  AdminError,
  createDraft,
  submitDraftForReview,
  approveDraft,
  publishDraft,
  patchDraft,
  createResearchRun,
  cancelResearchRun,
  retryResearchRun,
  moderateTicket,
  createUploadIntent,
  finalizeUpload,
} from '../src/services/admin.service.js';

describe('draft state machine', () => {
  it('walks draft -> review -> approved -> published', () => {
    const store = new AdminStore();
    const d = createDraft(store, 'editor-1', { subjectId: '11111111-1111-4111-8111-111111111111', slug: 'x' });
    expect(d.status).toBe('draft');
    expect(submitDraftForReview(store, 'editor-1', d.id).status).toBe('in_review');
    expect(approveDraft(store, 'editor-1', d.id).status).toBe('approved');
    expect(publishDraft(store, 'editor-1', d.id).status).toBe('published');
    expect(store.audit.length).toBeGreaterThan(0);
  });

  it('rejects invalid transitions', () => {
    const store = new AdminStore();
    const d = createDraft(store, 'editor-1', { subjectId: '11111111-1111-4111-8111-111111111111', slug: 'x' });
    expect(() => approveDraft(store, 'editor-1', d.id)).toThrow(AdminError);
    expect(() => publishDraft(store, 'editor-1', d.id)).toThrow(AdminError);
  });

  it('rejects patching a non-draft', () => {
    const store = new AdminStore();
    const d = createDraft(store, 'editor-1', { subjectId: '11111111-1111-4111-8111-111111111111', slug: 'x' });
    submitDraftForReview(store, 'editor-1', d.id);
    expect(() => patchDraft(store, 'editor-1', d.id, { slug: 'y' })).toThrow(AdminError);
  });
});

describe('research runs', () => {
  it('queues when models are available, awaits provider otherwise', () => {
    const store = new AdminStore();
    expect(createResearchRun(store, 'a', { subject: 'x', modelsAvailable: true }).status).toBe('queued');
    expect(createResearchRun(store, 'a', { subject: 'y', modelsAvailable: false }).status).toBe('awaiting_provider');
  });

  it('cancel/retry follow the lifecycle', () => {
    const store = new AdminStore();
    const run = createResearchRun(store, 'a', { subject: 'x', modelsAvailable: true });
    expect(cancelResearchRun(store, 'a', run.id).status).toBe('cancelled');
    expect(retryResearchRun(store, 'a', run.id, true).status).toBe('queued');
    expect(() => retryResearchRun(store, 'a', run.id, true)).toThrow(AdminError);
  });
});

describe('moderation tickets', () => {
  it('moderates open tickets exactly once', () => {
    const store = new AdminStore();
    store.tickets.set('t1', { id: 't1', kind: 'submission', status: 'open' });
    expect(moderateTicket(store, 'mod', 't1', 'accepted').status).toBe('accepted');
    expect(() => moderateTicket(store, 'mod', 't1', 'rejected')).toThrow(AdminError);
  });
});

describe('asset upload intents', () => {
  it('validates type and size on intent creation', () => {
    const store = new AdminStore();
    const intent = createUploadIntent(store, 'editor', { filename: 'hero.png', contentType: 'image/png', bytes: 1024 });
    expect(intent.quarantineKey.startsWith('quarantine/')).toBe(true);
    expect(() => createUploadIntent(store, 'editor', { filename: 'x.exe', contentType: 'application/x-msdownload', bytes: 10 })).toThrow(AdminError);
    expect(() => createUploadIntent(store, 'editor', { filename: 'big.png', contentType: 'image/png', bytes: 10 ** 9 })).toThrow(AdminError);
  });

  it('finalize rejects size mismatch, type mismatch, and dirty scans', () => {
    const store = new AdminStore();
    const mk = () => createUploadIntent(store, 'editor', { filename: 'a.png', contentType: 'image/png', bytes: 100 });
    expect(() => finalizeUpload(store, 'editor', mk().id, { actualBytes: 99 }, true, true)).toThrow(AdminError);
    expect(() => finalizeUpload(store, 'editor', mk().id, { actualBytes: 100, actualContentType: 'image/jpeg' }, true, true)).toThrow(AdminError);
    expect(() => finalizeUpload(store, 'editor', mk().id, { actualBytes: 100 }, false, true)).toThrow(AdminError);
    const ok = finalizeUpload(store, 'editor', mk().id, { actualBytes: 100, actualContentType: 'image/png' }, true, true);
    expect(ok.publicKey).toContain('assets/');
    // single-use: second finalize fails
    expect(() => finalizeUpload(store, 'editor', ok.intent.id, { actualBytes: 100 }, true, true)).toThrow(AdminError);
  });
});
