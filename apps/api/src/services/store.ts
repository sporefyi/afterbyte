/**
 * Read-model port for the API. Business rules live in services; handlers are
 * thin. The database lane provides the Drizzle-backed implementation of this
 * interface; this file ships a memory implementation (empty by default, or a
 * clearly-labelled synthetic fixture set when AFTERBYTE_SEED_FIXTURES=1).
 *
 * No invented production data: with no seed, lists are empty and detail
 * endpoints return 404. Fixture mode reports dataMode "fixture".
 */

export type Category = 'app' | 'website' | 'game' | 'meme' | 'community' | 'crypto';
export type LifecycleStatus = 'active' | 'declining' | 'uncertain' | 'dormant' | 'defunct';
export type EvidenceBand = 'strong' | 'moderate' | 'limited' | 'weak';
export type ProofStatus = 'pending' | 'anchored' | 'failed';
export type DossierSort = 'relevance' | 'recently_updated' | 'recently_verified';

export interface DossierSummary {
  id: string;
  slug: string;
  name: string;
  category: Category;
  version: number;
  summary: string;
  lifecycleStatus: LifecycleStatus;
  publishedAt: string;
  lastReviewedAt: string | null;
  sourceCount: number;
}

export interface DossierDetail extends DossierSummary {
  statusReason: string | null;
  evidenceAssessment: { band: EvidenceBand; reason: string } | null;
  lastObservedAt: string | null;
  nextReviewAt: string | null;
  heroAsset: { url: string; alt: string } | null;
  sections: { id: string; heading: string; blocks: unknown[] }[];
  timelinePreview: { id: string; occurredAt: string; title: string }[];
  proof: { status: ProofStatus; receiptId: string | null; signature: string | null };
  availableMetrics: string[];
  relationsPreview: { slug: string; name: string; relationshipType: string }[];
}

export interface VersionSummary {
  version: number;
  publishedAt: string;
  changeCount: number;
  summary: string;
  label: 'published' | 'correction' | 'retraction';
}

export interface TimelineEvent {
  id: string;
  occurredAt: string;
  datePrecision: 'day' | 'month' | 'year';
  title: string;
  type: string;
  description: string;
  sources: string[];
}

export interface SourceRecord {
  id: string;
  url: string;
  title: string;
  addedAt: string;
  archived: boolean;
  excerpt: string | null;
}

export interface MetricObservation {
  id: string;
  metricKey: string;
  value: string;
  unit: string;
  observedAt: string;
  source: string;
  coverageStart: string | null;
  coverageEnd: string | null;
}

export interface RelationEdge {
  id: string;
  targetSlug: string;
  targetName: string;
  relationshipType: string;
  strength: 'strong' | 'moderate' | 'weak';
  reason: string;
  claimIds: string[];
}

export interface ChangeEntry {
  id: string;
  version: number;
  changedAt: string;
  changeType: 'correction' | 'retraction' | 'update';
  explanation: string;
  diff: { path: string; before: string | null; after: string | null }[];
}

export interface CollectionDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  dossierCount: number;
  dossiers: DossierSummary[];
}

export interface SuggestItem {
  slug: string;
  name: string;
  category: Category;
}

export type PublicEventType =
  | 'dossier.published'
  | 'dossier.corrected'
  | 'dossier.retracted'
  | 'subject.status_changed'
  | 'research.started'
  | 'research.completed'
  | 'receipt.finalized';

export interface ActivityEvent {
  eventId: string;
  sequenceId: string; // BIGINT serialized as string
  eventType: PublicEventType;
  occurredAt: string;
  subjectId: string;
  dossierVersion: number | null;
  aggregateRevision: number;
  payload: Record<string, unknown>;
}

export interface StatsPayload {
  archiveCount: number;
  activeCount: number;
  recordedCount: number;
  byLifecycle: Record<LifecycleStatus, number>;
  byCategory: Record<Category, number>;
  asOf: string;
  definitions: Record<string, string>;
}

export interface ReceiptDetail {
  id: string;
  dossierSlug: string;
  version: number;
  status: 'pending' | 'finalized' | 'failed';
  signature: string | null;
  transactionId: string | null;
  payloadHash: string;
  createdAt: string;
  finalizedAt: string | null;
  canonicalBundleUrl: string | null;
}

export interface ConfigPayload {
  brand: { name: string; tagline: string };
  canonicalUrls: { site: string; api: string };
  features: { paymentsEnabled: boolean; tokenEnabled: boolean; researchEnabled: boolean };
  chain: string;
  programId: string | null;
  acceptedPaymentAssets: string[];
  providerStatus: {
    search: 'operational' | 'unavailable';
    models: 'operational' | 'unavailable';
    receipts: 'operational' | 'unavailable';
    storage: 'operational' | 'unavailable';
  };
}

export interface HomePayload {
  editionId: string;
  headline: string;
  featured: DossierSummary[];
  recentChanges: ChangeEntry[];
  stillAlive: DossierSummary[];
  researchFeedPreview: { id: string; title: string; status: string }[];
  stats: StatsPayload;
}

export interface MethodologyPayload {
  version: string;
  updatedAt: string;
  sections: { id: string; heading: string; body: string }[];
}

export interface StatusPayload {
  status: 'operational' | 'degraded';
  asOf: string;
  components: { name: string; status: 'operational' | 'degraded' | 'down'; detail: string }[];
}

export interface SharePayload {
  slug: string;
  version: number;
  title: string;
  imageUrl: string | null;
  metadata: Record<string, string>;
}

export interface ListDossiersOptions {
  q?: string;
  category?: Category;
  lifecycleStatus?: LifecycleStatus;
  era?: string;
  sort: DossierSort;
  limit: number;
  cursor?: string;
}

export interface PageInput {
  limit: number;
  cursor?: string;
}

/** Personal records — object-level ownership enforced by handlers. */
export interface BookmarkRecord {
  subjectId: string;
  dossierSlug: string;
  createdAt: string;
}
export interface WatchlistRecord {
  subjectId: string;
  dossierSlug: string;
  createdAt: string;
}
export interface NotificationRecord {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}
export interface MeProfile {
  userId: string;
  address: string;
  roles: string[];
  capabilities: string[];
  createdAt: string;
}
export interface SubmissionTicket {
  id: string;
  userId: string;
  subjectName: string;
  candidateUrls: string[];
  reason: string;
  status: 'open' | 'accepted' | 'rejected';
  createdAt: string;
}
export interface CorrectionTicket {
  id: string;
  userId: string;
  dossierSlug: string;
  claimedIssue: string;
  evidenceUrls: string[];
  explanatoryText: string;
  status: 'open' | 'accepted' | 'rejected';
  createdAt: string;
}

export interface ReadStore {
  // public reads
  getConfig(): ConfigPayload;
  getHome(): HomePayload;
  getStats(): StatsPayload;
  listDossiers(opts: ListDossiersOptions): { items: DossierSummary[]; nextCursor: string | null };
  getDossier(slug: string): DossierDetail | null;
  listVersions(slug: string, page: PageInput): { items: VersionSummary[]; nextCursor: string | null } | null;
  getVersion(slug: string, version: number): DossierDetail | null;
  getCanonical(slug: string, version: number): { bytes: Buffer; sha256: string } | null;
  listTimeline(slug: string, page: PageInput): { items: TimelineEvent[]; nextCursor: string | null } | null;
  listSources(slug: string, page: PageInput): { items: SourceRecord[]; nextCursor: string | null } | null;
  listMetrics(slug: string, page: PageInput): { items: MetricObservation[]; nextCursor: string | null } | null;
  listRelations(slug: string, page: PageInput): { items: RelationEdge[]; nextCursor: string | null } | null;
  listChanges(slug: string, page: PageInput): { items: ChangeEntry[]; nextCursor: string | null } | null;
  getCollection(slug: string): CollectionDetail | null;
  suggest(q: string, limit: number): SuggestItem[];
  listActivity(page: PageInput, eventType?: PublicEventType): { items: ActivityEvent[]; nextCursor: string | null };
  getReceipt(id: string): ReceiptDetail | null;
  getMethodology(): MethodologyPayload;
  getStatus(): StatusPayload;
  getShare(slug: string, version: number): SharePayload | null;
  // personal
  getOrCreateProfile(userId: string, address: string): MeProfile;
  listBookmarks(userId: string): BookmarkRecord[];
  putBookmark(userId: string, subjectId: string, dossierSlug: string): BookmarkRecord;
  deleteBookmark(userId: string, subjectId: string): boolean;
  listWatchlist(userId: string): WatchlistRecord[];
  putWatchlist(userId: string, subjectId: string, dossierSlug: string): WatchlistRecord;
  deleteWatchlist(userId: string, subjectId: string): boolean;
  listNotifications(userId: string): NotificationRecord[];
  markNotificationRead(userId: string, id: string): NotificationRecord | null;
  createSubmission(userId: string, input: { subjectName: string; candidateUrls: string[]; reason: string }): SubmissionTicket;
  createCorrection(userId: string, dossierSlug: string, input: { claimedIssue: string; evidenceUrls: string[]; explanatoryText: string }): CorrectionTicket;
  listMySubmissions(userId: string): SubmissionTicket[];
  listMyOrders(userId: string): unknown[];
}
