/**
 * AFTERBYTE v1 typed API client.
 *
 * Fetch-based. No database imports anywhere — this package is the frozen
 * frontend contract (Milestone 1) and must stay dependency-light.
 *
 * Conventions (brief §12):
 * - Every response (except canonical bytes + SSE) is the envelope
 *   `{ data, meta: { requestId, asOf, dataMode, freshness, nextCursor } }`.
 * - Errors throw ApiError parsed from the error envelope.
 * - Cursor pagination: `meta.nextCursor`; default page size 24, max 100.
 * - Pass `ifNoneMatch` on public reads; a 304 resolves to `null`.
 * - Mutations that require Idempotency-Key get one auto-generated per call
 *   (crypto.randomUUID) unless the caller supplies `idempotencyKey`.
 * - `dataMode` is "live" in production; fixtures are labelled "demo" and are
 *   NEVER served by production.
 */
import type { components } from './types.js';

type Schemas = components['schemas'];

export type AppConfig = Schemas['AppConfig'];
export type HomeEdition = Schemas['HomeEdition'];
export type StatsSnapshot = Schemas['StatsSnapshot'];
export type DossierSummary = Schemas['DossierSummary'];
export type DossierDetail = Schemas['DossierDetail'];
export type VersionSummary = Schemas['VersionSummary'];
export type VersionDetail = Schemas['VersionDetail'];
export type TimelineEvent = Schemas['TimelineEvent'];
export type SourceRecord = Schemas['SourceRecord'];
export type MetricObservation = Schemas['MetricObservation'];
export type Relation = Schemas['Relation'];
export type ChangeEntry = Schemas['ChangeEntry'];
export type Collection = Schemas['Collection'];
export type SuggestHit = Schemas['SuggestHit'];
export type ActivityEvent = Schemas['ActivityEvent'];
export type Receipt = Schemas['Receipt'];
export type Methodology = Schemas['Methodology'];
export type ServiceStatus = Schemas['ServiceStatus'];
export type ShareCard = Schemas['ShareCard'];
export type User = Schemas['User'];
export type Bookmark = Schemas['Bookmark'];
export type WatchlistItem = Schemas['WatchlistItem'];
export type Notification = Schemas['Notification'];
export type Submission = Schemas['Submission'];
export type Correction = Schemas['Correction'];
export type ResearchRun = Schemas['ResearchRun'];
export type Draft = Schemas['Draft'];
export type HomeEditionAdmin = Schemas['HomeEditionAdmin'];
export type ProviderStatus = Schemas['ProviderStatus'];
export type QueueHealth = Schemas['QueueHealth'];
export type CostReport = Schemas['CostReport'];
export type AuditLogEntry = Schemas['AuditLogEntry'];
export type Asset = Schemas['Asset'];
export type UploadIntent = Schemas['UploadIntent'];
export type InvestigationOrder = Schemas['InvestigationOrder'];
export type PaymentIntent = Schemas['PaymentIntent'];
export type Refund = Schemas['Refund'];
export type Award = Schemas['Award'];
export type ResponseMeta = Schemas['ResponseMeta'];
export type ErrorCode = Schemas['ErrorCode'];

export interface Envelope<T> {
  data: T;
  meta: ResponseMeta;
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly fieldErrors: FieldError[];

  constructor(opts: {
    status: number;
    code: ErrorCode | string;
    message: string;
    requestId?: string;
    retryable?: boolean;
    retryAfter?: number;
    fieldErrors?: FieldError[];
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.retryable = opts.retryable ?? false;
    this.retryAfter = opts.retryAfter;
    this.fieldErrors = opts.fieldErrors ?? [];
  }
}

export interface ClientOptions {
  /** e.g. "https://{API_ORIGIN}/api/v1" once deployed. No real URL is claimed here. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Bearer token supplier for identity/admin endpoints (may be async). */
  getToken?: () => string | undefined | Promise<string | undefined>;
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** Override the auto-generated Idempotency-Key (mutations that require it). */
  idempotencyKey?: string | null;
  signal?: AbortSignal;
}

const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export class AfterbyteClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly getToken?: () => string | undefined | Promise<string | undefined>;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.getToken = opts.getToken;
    this.defaultHeaders = opts.defaultHeaders ?? {};
  }

  private async requestRaw(
    method: string,
    path: string,
    opts: RequestOptions & { body?: unknown } = {},
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.defaultHeaders,
      ...opts.headers,
    };
    if (this.getToken) {
      const token = await this.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (IDEMPOTENT_METHODS.has(method) && opts.idempotencyKey !== null) {
      headers['Idempotency-Key'] =
        opts.idempotencyKey ?? randomUuid();
    }
    return this.doFetch(url.toString(), { method, headers, body, signal: opts.signal });
  }

  private async parseError(res: Response): Promise<ApiError> {
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    let code: string = 'UNKNOWN';
    let message = `request failed with status ${res.status}`;
    let requestId: string | undefined;
    let retryable = res.status === 429 || res.status === 503;
    let fieldErrors: FieldError[] = [];
    try {
      const json = (await res.json()) as {
        error?: {
          code?: string;
          message?: string;
          requestId?: string;
          retryable?: boolean;
          fieldErrors?: FieldError[];
        };
      };
      if (json?.error) {
        code = json.error.code ?? code;
        message = json.error.message ?? message;
        requestId = json.error.requestId;
        retryable = json.error.retryable ?? retryable;
        fieldErrors = json.error.fieldErrors ?? [];
      }
    } catch {
      /* non-JSON error body — keep the generic shape */
    }
    return new ApiError({
      status: res.status,
      code,
      message,
      requestId,
      retryable,
      retryAfter,
      fieldErrors,
    });
  }

  /**
   * Low-level JSON request. Returns the envelope on 2xx, `null` on 304,
   * and throws ApiError otherwise.
   */
  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions & { body?: unknown } = {},
  ): Promise<Envelope<T> | null> {
    const res = await this.requestRaw(method, path, opts);
    if (res.status === 304) return null;
    if (!res.ok) throw await this.parseError(res);
    if (res.status === 204) return { data: undefined as T, meta: undefined as unknown as ResponseMeta };
    const json = (await res.json()) as Envelope<T>;
    return json;
  }

  private async envelope<T>(
    method: string,
    path: string,
    opts: RequestOptions & { body?: unknown } = {},
  ): Promise<Envelope<T>> {
    const out = await this.request<T>(method, path, opts);
    if (out === null) throw new ApiError({ status: 304, code: 'NOT_MODIFIED', message: 'not modified' });
    return out;
  }

  // ------------------------------------------------------------------
  // public
  // ------------------------------------------------------------------

  getConfig(opts: RequestOptions & { ifNoneMatch?: string } = {}) {
    return this.request<AppConfig>('GET', '/config', {
      ...opts,
      headers: withIfNoneMatch(opts),
    });
  }

  getHome(opts: RequestOptions & { ifNoneMatch?: string } = {}) {
    return this.request<HomeEdition>('GET', '/home', {
      ...opts,
      headers: withIfNoneMatch(opts),
    });
  }

  listDossiers(
    params: {
      q?: string;
      category?: string;
      lifecycleStatus?: string;
      era?: string;
      sort?: 'relevance' | 'recently_updated' | 'recently_verified';
      cursor?: string;
      limit?: number;
    } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<DossierSummary[]>('GET', '/dossiers', {
      ...opts,
      query: { ...params },
    });
  }

  getDossier(slug: string, opts: RequestOptions & { ifNoneMatch?: string } = {}) {
    return this.request<DossierDetail>('GET', `/dossiers/${enc(slug)}`, {
      ...opts,
      headers: withIfNoneMatch(opts),
    });
  }

  listDossierVersions(
    slug: string,
    params: { cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<VersionSummary[]>('GET', `/dossiers/${enc(slug)}/versions`, {
      ...opts,
      query: { ...params },
    });
  }

  getDossierVersion(
    slug: string,
    version: number,
    opts: RequestOptions & { ifNoneMatch?: string } = {},
  ) {
    return this.request<VersionDetail>(
      'GET',
      `/dossiers/${enc(slug)}/versions/${version}`,
      { ...opts, headers: withIfNoneMatch(opts) },
    );
  }

  /**
   * Exact canonical bytes for hash verification — NOT the JSON envelope.
   * Returns the bytes and the ETag.
   */
  async getDossierVersionCanonical(
    slug: string,
    version: number,
    opts: RequestOptions = {},
  ): Promise<{ bytes: Uint8Array; etag: string | null }> {
    const res = await this.requestRaw(
      'GET',
      `/dossiers/${enc(slug)}/versions/${version}/canonical`,
      opts,
    );
    if (!res.ok) throw await this.parseError(res);
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), etag: res.headers.get('ETag') };
  }

  getDossierTimeline(slug: string, opts: RequestOptions = {}) {
    return this.envelope<TimelineEvent[]>('GET', `/dossiers/${enc(slug)}/timeline`, opts);
  }

  getDossierSources(
    slug: string,
    params: { cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<SourceRecord[]>('GET', `/dossiers/${enc(slug)}/sources`, {
      ...opts,
      query: { ...params },
    });
  }

  getDossierMetrics(slug: string, opts: RequestOptions = {}) {
    return this.envelope<MetricObservation[]>('GET', `/dossiers/${enc(slug)}/metrics`, opts);
  }

  getDossierRelations(
    slug: string,
    params: { claimId?: string; cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Relation[]>('GET', `/dossiers/${enc(slug)}/relations`, {
      ...opts,
      query: { ...params },
    });
  }

  getDossierChanges(slug: string, opts: RequestOptions = {}) {
    return this.envelope<ChangeEntry[]>('GET', `/dossiers/${enc(slug)}/changes`, opts);
  }

  getCollection(slug: string, opts: RequestOptions & { ifNoneMatch?: string } = {}) {
    return this.request<Collection>('GET', `/collections/${enc(slug)}`, {
      ...opts,
      headers: withIfNoneMatch(opts),
    });
  }

  suggestSearch(q: string, opts: RequestOptions = {}) {
    return this.envelope<SuggestHit[]>('GET', '/search/suggest', {
      ...opts,
      query: { q },
    });
  }

  listActivity(
    params: { after?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<ActivityEvent[]>('GET', '/activity', {
      ...opts,
      query: { ...params },
    });
  }

  getStats(opts: RequestOptions & { ifNoneMatch?: string } = {}) {
    return this.request<StatsSnapshot>('GET', '/stats', {
      ...opts,
      headers: withIfNoneMatch(opts),
    });
  }

  getReceipt(id: string, opts: RequestOptions = {}) {
    return this.envelope<Receipt>('GET', `/receipts/${enc(id)}`, opts);
  }

  getMethodology(opts: RequestOptions & { ifNoneMatch?: string } = {}) {
    return this.request<Methodology>('GET', '/methodology', {
      ...opts,
      headers: withIfNoneMatch(opts),
    });
  }

  getServiceStatus(opts: RequestOptions = {}) {
    return this.envelope<ServiceStatus>('GET', '/status', opts);
  }

  getShareCard(slug: string, version: number, opts: RequestOptions = {}) {
    return this.envelope<ShareCard>('GET', `/share/dossiers/${enc(slug)}/${version}`, opts);
  }

  /**
   * Public SSE stream (text/event-stream). At-least-once delivery: callers
   * must deduplicate by eventId and ignore older aggregateRevision values.
   * Heartbeats arrive as comment lines and are swallowed here. Resolves when
   * the signal aborts or the stream ends.
   */
  async streamEvents(opts: {
    onEvent: (event: StreamEvent) => void;
    onError?: (err: unknown) => void;
    lastEventId?: string;
    after?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
    const query: Record<string, string | undefined> = { after: opts.after };
    const url = new URL(this.baseUrl + '/events/stream');
    if (query.after) url.searchParams.set('after', query.after);
    const res = await this.doFetch(url.toString(), { headers, signal: opts.signal });
    if (!res.ok || !res.body) throw await this.parseError(res);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let current: Record<string, string> = {};
    const flush = () => {
      if (current.data !== undefined) {
        try {
          const parsed = JSON.parse(current.data) as StreamEvent;
          opts.onEvent(parsed);
        } catch (err) {
          opts.onError?.(err);
        }
      }
      current = {};
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line === '') {
            flush();
          } else if (line.startsWith(':')) {
            // heartbeat/comment — ignore
          } else {
            const colon = line.indexOf(':');
            if (colon > 0) {
              const field = line.slice(0, colon);
              const value = line.slice(colon + 1).trimStart();
              if (field === 'data') current.data = (current.data ?? '') + value;
              else current[field] = value;
            }
          }
        }
      }
      flush();
    } finally {
      reader.releaseLock();
    }
  }
  // ------------------------------------------------------------------
  // identity
  // ------------------------------------------------------------------

  postAuthChallenge(
    body: Schemas['AuthChallengeRequest'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<Schemas['AuthChallengeResponse']['data']>(
      'POST',
      '/auth/challenge',
      { ...opts, body, idempotencyKey: null },
    );
  }

  postAuthVerify(body: Schemas['AuthVerifyRequest'], opts: RequestOptions = {}) {
    return this.envelope<Schemas['AuthToken']>('POST', '/auth/verify', {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  postAuthLogout(opts: RequestOptions = {}) {
    return this.envelope<{ revoked: boolean }>('POST', '/auth/logout', {
      ...opts,
      idempotencyKey: null,
    });
  }

  getMe(opts: RequestOptions = {}) {
    return this.envelope<User>('GET', '/me', opts);
  }

  listBookmarks(
    params: { cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Bookmark[]>('GET', '/me/bookmarks', {
      ...opts,
      query: { ...params },
    });
  }

  putBookmark(subjectId: string, opts: RequestOptions = {}) {
    return this.envelope<Bookmark>('PUT', `/me/bookmarks/${enc(subjectId)}`, {
      ...opts,
      idempotencyKey: null,
    });
  }

  async deleteBookmark(subjectId: string, opts: RequestOptions = {}): Promise<void> {
    await this.request<void>('DELETE', `/me/bookmarks/${enc(subjectId)}`, {
      ...opts,
      idempotencyKey: null,
    });
  }

  listWatchlist(
    params: { cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<WatchlistItem[]>('GET', '/me/watchlist', {
      ...opts,
      query: { ...params },
    });
  }

  putWatchlistItem(
    subjectId: string,
    body: { note?: string } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<WatchlistItem>('PUT', `/me/watchlist/${enc(subjectId)}`, {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  async deleteWatchlistItem(subjectId: string, opts: RequestOptions = {}): Promise<void> {
    await this.request<void>('DELETE', `/me/watchlist/${enc(subjectId)}`, {
      ...opts,
      idempotencyKey: null,
    });
  }

  listNotifications(
    params: { unreadOnly?: boolean; cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Notification[]>('GET', '/me/notifications', {
      ...opts,
      query: { ...params },
    });
  }

  patchNotification(
    id: string,
    body: Schemas['NotificationReadUpdate'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<Notification>('PATCH', `/me/notifications/${enc(id)}`, {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  createSubmission(body: Schemas['SubmissionCreate'], opts: RequestOptions = {}) {
    return this.envelope<Submission>('POST', '/submissions', { ...opts, body });
  }

  createCorrection(
    slug: string,
    body: Schemas['CorrectionCreate'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<Correction>('POST', `/dossiers/${enc(slug)}/corrections`, {
      ...opts,
      body,
    });
  }

  listMySubmissions(
    params: { cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Submission[]>('GET', '/me/submissions', {
      ...opts,
      query: { ...params },
    });
  }

  listMyOrders(
    params: { cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<InvestigationOrder[]>('GET', '/me/orders', {
      ...opts,
      query: { ...params },
    });
  }

  // ------------------------------------------------------------------
  // admin — every route performs a permission check server-side
  // ------------------------------------------------------------------

  listResearchRuns(
    params: { status?: string; kind?: string; cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<ResearchRun[]>('GET', '/admin/research-runs', {
      ...opts,
      query: { ...params },
    });
  }

  createResearchRun(body: Schemas['ResearchRunCreate'], opts: RequestOptions = {}) {
    return this.envelope<ResearchRun>('POST', '/admin/research-runs', {
      ...opts,
      body,
    });
  }

  getResearchRun(id: string, opts: RequestOptions = {}) {
    return this.envelope<ResearchRun>('GET', `/admin/research-runs/${enc(id)}`, opts);
  }

  cancelResearchRun(id: string, opts: RequestOptions = {}) {
    return this.envelope<ResearchRun>(
      'POST',
      `/admin/research-runs/${enc(id)}/cancel`,
      { ...opts, idempotencyKey: null },
    );
  }

  retryResearchRun(id: string, opts: RequestOptions = {}) {
    return this.envelope<ResearchRun>('POST', `/admin/research-runs/${enc(id)}/retry`, {
      ...opts,
      idempotencyKey: null,
    });
  }

  listDrafts(
    params: { status?: string; subjectId?: string; cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Draft[]>('GET', '/admin/drafts', {
      ...opts,
      query: { ...params },
    });
  }

  getDraft(id: string, opts: RequestOptions = {}) {
    return this.envelope<Draft>('GET', `/admin/drafts/${enc(id)}`, opts);
  }

  patchDraft(
    id: string,
    body: Schemas['DraftPatch'],
    opts: RequestOptions & { ifMatch?: string } = {},
  ) {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    return this.envelope<Draft>('PATCH', `/admin/drafts/${enc(id)}`, {
      ...opts,
      headers,
      body,
      idempotencyKey: null,
    });
  }

  submitDraftReview(id: string, opts: RequestOptions = {}) {
    return this.envelope<Draft>('POST', `/admin/drafts/${enc(id)}/submit-review`, {
      ...opts,
      idempotencyKey: null,
    });
  }

  approveDraft(
    id: string,
    body: { expectedRevision: number },
    opts: RequestOptions = {},
  ) {
    return this.envelope<Draft>('POST', `/admin/drafts/${enc(id)}/approve`, {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  publishDraft(id: string, body: Schemas['PublishRequest'], opts: RequestOptions = {}) {
    return this.envelope<VersionSummary>('POST', `/admin/drafts/${enc(id)}/publish`, {
      ...opts,
      body,
    });
  }

  retractDossier(
    id: string,
    body: Schemas['RetractRequest'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<{ id: string; slug: string; status: 'retracted' }>(
      'POST',
      `/admin/dossiers/${enc(id)}/retract`,
      { ...opts, body },
    );
  }

  scheduleRecheck(id: string, opts: RequestOptions = {}) {
    return this.envelope<ResearchRun>(
      'POST',
      `/admin/dossiers/${enc(id)}/schedule-recheck`,
      { ...opts, idempotencyKey: null },
    );
  }

  listAdminSubmissions(
    params: { status?: string; cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Submission[]>('GET', '/admin/submissions', {
      ...opts,
      query: { ...params },
    });
  }

  getAdminSubmission(id: string, opts: RequestOptions = {}) {
    return this.envelope<Submission>('GET', `/admin/submissions/${enc(id)}`, opts);
  }

  moderateSubmission(
    id: string,
    body: Schemas['ModerationDecision'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<Submission>('PATCH', `/admin/submissions/${enc(id)}`, {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  listAdminCorrections(
    params: { status?: string; cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Correction[]>('GET', '/admin/corrections', {
      ...opts,
      query: { ...params },
    });
  }

  getAdminCorrection(id: string, opts: RequestOptions = {}) {
    return this.envelope<Correction>('GET', `/admin/corrections/${enc(id)}`, opts);
  }

  moderateCorrection(
    id: string,
    body: Schemas['ModerationDecision'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<Correction>('PATCH', `/admin/corrections/${enc(id)}`, {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  getHomeEdition(id: string, opts: RequestOptions = {}) {
    return this.envelope<HomeEditionAdmin>('GET', `/admin/home-editions/${enc(id)}`, opts);
  }

  patchHomeEdition(
    id: string,
    body: Schemas['HomeEditionPatch'],
    opts: RequestOptions & { ifMatch?: string } = {},
  ) {
    const headers = { ...(opts.headers ?? {}) };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    return this.envelope<HomeEditionAdmin>('PATCH', `/admin/home-editions/${enc(id)}`, {
      ...opts,
      headers,
      body,
      idempotencyKey: null,
    });
  }

  listProviders(opts: RequestOptions = {}) {
    return this.envelope<ProviderStatus[]>('GET', '/admin/providers', opts);
  }

  getCosts(params: { from?: string; to?: string } = {}, opts: RequestOptions = {}) {
    return this.envelope<CostReport>('GET', '/admin/costs', {
      ...opts,
      query: { ...params },
    });
  }

  getQueues(opts: RequestOptions = {}) {
    return this.envelope<QueueHealth[]>('GET', '/admin/queues', opts);
  }

  listAuditLog(
    params: { actorId?: string; action?: string; cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<AuditLogEntry[]>('GET', '/admin/audit-log', {
      ...opts,
      query: { ...params },
    });
  }

  listFailedReceipts(
    params: { cursor?: string; limit?: number } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<Receipt[]>('GET', '/admin/receipts/failed', {
      ...opts,
      query: { ...params },
    });
  }

  createUploadIntent(body: Schemas['UploadIntentRequest'], opts: RequestOptions = {}) {
    return this.envelope<UploadIntent>('POST', '/admin/assets/upload-intent', {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  finalizeAsset(id: string, opts: RequestOptions = {}) {
    return this.envelope<Asset>('POST', `/admin/assets/${enc(id)}/finalize`, {
      ...opts,
      idempotencyKey: null,
    });
  }

  // ------------------------------------------------------------------
  // payments — Release B, behind the payments feature flag.
  // While PAYMENTS_ENABLED=false every endpoint returns 503
  // FEATURE_UNAVAILABLE; the frontend hides payment CTAs via /config.
  // ------------------------------------------------------------------

  createInvestigationOrder(
    body: Schemas['InvestigationOrderCreate'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<InvestigationOrder>('POST', '/investigation-orders', {
      ...opts,
      body,
    });
  }

  getInvestigationOrder(id: string, opts: RequestOptions = {}) {
    return this.envelope<InvestigationOrder>('GET', `/investigation-orders/${enc(id)}`, opts);
  }

  acceptQuote(id: string, opts: RequestOptions = {}) {
    return this.envelope<InvestigationOrder>(
      'POST',
      `/investigation-orders/${enc(id)}/accept-quote`,
      opts,
    );
  }

  createPaymentIntent(
    body: { orderId: string; payerAddress: string; asset: string },
    opts: RequestOptions = {},
  ) {
    return this.envelope<PaymentIntent>('POST', '/payment-intents', {
      ...opts,
      body,
    });
  }

  getPaymentIntent(id: string, opts: RequestOptions = {}) {
    return this.envelope<PaymentIntent>('GET', `/payment-intents/${enc(id)}`, opts);
  }

  submitPaymentSignature(
    id: string,
    body: Schemas['SubmitSignatureRequest'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<PaymentIntent>(
      'POST',
      `/payment-intents/${enc(id)}/submit-signature`,
      { ...opts, body },
    );
  }

  requestRefund(
    orderId: string,
    body: Schemas['RefundRequest'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<Refund>(
      'POST',
      `/investigation-orders/${enc(orderId)}/refund-request`,
      { ...opts, body },
    );
  }

  getRefund(id: string, opts: RequestOptions = {}) {
    return this.envelope<Refund>('GET', `/refunds/${enc(id)}`, opts);
  }

  adminAcceptOrder(
    id: string,
    body: { note?: string } = {},
    opts: RequestOptions = {},
  ) {
    return this.envelope<InvestigationOrder>(
      'POST',
      `/admin/investigation-orders/${enc(id)}/accept`,
      { ...opts, body, idempotencyKey: null },
    );
  }

  adminCreateQuote(
    id: string,
    body: Schemas['Quote'],
    opts: RequestOptions = {},
  ) {
    return this.envelope<InvestigationOrder>(
      'POST',
      `/admin/investigation-orders/${enc(id)}/quote`,
      { ...opts, body, idempotencyKey: null },
    );
  }

  adminApproveRefund(
    id: string,
    body: { decision: 'approve' | 'reject'; note?: string },
    opts: RequestOptions = {},
  ) {
    return this.envelope<Refund>('POST', `/admin/refunds/${enc(id)}/approve`, {
      ...opts,
      body,
      idempotencyKey: null,
    });
  }

  adminCreateAward(body: Schemas['AwardCreate'], opts: RequestOptions = {}) {
    return this.envelope<Award>('POST', '/admin/awards', { ...opts, body });
  }
}

export interface StreamEvent {
  eventId: string;
  sequenceId: string;
  eventType:
    | 'dossier.published'
    | 'dossier.corrected'
    | 'dossier.retracted'
    | 'subject.status_changed'
    | 'research.started'
    | 'research.completed'
    | 'receipt.finalized'
    | 'resync_required';
  occurredAt: string;
  subjectId?: string;
  dossierVersion?: number;
  aggregateRevision: number;
  payload: Record<string, unknown>;
}

function enc(value: string | number): string {
  return encodeURIComponent(String(value));
}

function withIfNoneMatch(opts: { ifNoneMatch?: string; headers?: Record<string, string> }) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
  return headers;
}

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
