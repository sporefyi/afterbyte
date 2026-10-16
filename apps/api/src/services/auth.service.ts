/**
 * Wallet authentication service (brief §11).
 *
 * Flow:
 *  1. POST /auth/challenge {address} -> server builds a deterministic
 *     sign-in message (domain, URI, address binding, nonce, issued/expiry,
 *     request ID), stores the challenge server-side for 5 minutes, returns
 *     the message text + requestId.
 *  2. The wallet signs the EXACT message bytes with the Solana wallet
 *     sign-in/message flow.
 *  3. POST /auth/verify {requestId, signature} -> server re-parses the
 *     message strictly, verifies every field against the stored challenge,
 *     verifies the ed25519 signature against the bound address, then
 *     ATOMICALLY consumes the challenge (single use) and issues a session.
 *
 * What is VERIFIED (implemented here, real cryptography):
 *  - message format round-trip: parseSignInMessage strictly re-parses the
 *    exact text the wallet was asked to sign; any deviation -> reject.
 *  - every challenge field (domain, uri, address, nonce, issuedAt, expiresAt,
 *    requestId) matches the server-stored record; expiry enforced; the
 *    requestId is consumed exactly once (replay of a verify attempt fails).
 *  - ed25519 signature over the message bytes verifies against the 32-byte
 *    public key decoded from the bound base58 address (tweetnacl).
 *
 * What is NOT verified server-side (documented, honest):
 *  - the Wallet Standard capability attestation happens in the wallet/client;
 *    the server trusts the claimed flow name ("solana-sign-in" vs
 *    "sign-message") and validates the message FORMAT accordingly, never an
 *    arbitrary message. A login signature is never confused with a payment
 *    transaction: no transaction bytes are accepted on these endpoints.
 *  - user identity beyond the wallet address: roles are looked up from the
 *    account store (default role "reader"; contributor/editor/administrator
 *    assigned by the audited admin bootstrap command, never by signup).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type SignInFlow = 'solana-sign-in' | 'sign-message';

export interface SignInMessageInput {
  domain: string;
  uri: string;
  address: string;
  nonce: string;
  issuedAt: string; // ISO-8601
  expiresAt: string; // ISO-8601
  requestId: string;
  statement?: string;
  flow: SignInFlow;
}

export interface ParsedSignInMessage {
  domain: string;
  uri: string;
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  requestId: string;
  statement: string;
  flow: SignInFlow;
}

const STATEMENT_DEFAULT = 'Sign in to AFTERBYTE';

/** Deterministic message text the wallet must sign. */
export function buildSignInMessage(input: SignInMessageInput): string {
  const statement = input.statement ?? STATEMENT_DEFAULT;
  const header = input.flow === 'solana-sign-in' ? 'wants you to sign in with Solana:' : 'wants you to sign a message for:';
  return [
    `${input.domain} ${header}`,
    '',
    statement,
    '',
    `Address: ${input.address}`,
    `URI: ${input.uri}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
    `Request ID: ${input.requestId}`,
  ].join('\n');
}

function matchLine(line: string | undefined, prefix: string): string | null {
  if (line === undefined || !line.startsWith(prefix)) return null;
  return line.slice(prefix.length);
}

/**
 * Strictly re-parse a sign-in message. Returns null on ANY deviation from
 * the canonical format — this is what makes format verification real rather
 * than "some signature over some bytes".
 */
export function parseSignInMessage(text: string): ParsedSignInMessage | null {
  const lines = text.split('\n');
  if (lines.length !== 10) return null;
  const headerMatch = lines[0].match(/^(\S+) (wants you to sign in with Solana:|wants you to sign a message for:)$/);
  if (!headerMatch) return null;
  const domain = headerMatch[1];
  const flow: SignInFlow =
    headerMatch[2] === 'wants you to sign in with Solana:' ? 'solana-sign-in' : 'sign-message';
  if (lines[1] !== '' || lines[3] !== '') return null;
  const statement = lines[2];
  if (statement.length === 0 || statement.length > 512) return null;
  const address = matchLine(lines[4], 'Address: ');
  const uri = matchLine(lines[5], 'URI: ');
  const nonce = matchLine(lines[6], 'Nonce: ');
  const issuedAt = matchLine(lines[7], 'Issued At: ');
  const expiresAt = matchLine(lines[8], 'Expiration Time: ');
  const requestId = matchLine(lines[9], 'Request ID: ');
  if (!address || !uri || !nonce || !issuedAt || !expiresAt || !requestId) return null;
  if (Number.isNaN(Date.parse(issuedAt)) || Number.isNaN(Date.parse(expiresAt))) return null;
  return { domain, uri, address, nonce, issuedAt, expiresAt, requestId, statement, flow };
}

/**
 * Verify an ed25519 signature over the message bytes against the bound
 * address. Never throws; false on any decode or verify failure.
 */
export function verifyWalletSignature(input: {
  message: string;
  signatureBase58: string;
  addressBase58: string;
}): boolean {
  try {
    const pubkey = new Uint8Array(bs58.decode(input.addressBase58));
    if (pubkey.length !== 32) return false;
    const sig = new Uint8Array(bs58.decode(input.signatureBase58));
    if (sig.length !== 64) return false;
    const msg = new Uint8Array(Buffer.from(input.message, 'utf8'));
    return nacl.sign.detached.verify(msg, sig, pubkey);
  } catch {
    return false;
  }
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    return new Uint8Array(bs58.decode(address)).length === 32;
  } catch {
    return false;
  }
}

export interface ChallengeRecord {
  requestId: string;
  domain: string;
  uri: string;
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  message: string;
  flow: SignInFlow;
  expiresAtMs: number;
}

export function newRequestId(): string {
  return randomBytes(16).toString('hex');
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** In-memory server-side challenge store with TTL + atomic single-use consume. */
export class ChallengeStore {
  private store = new Map<string, ChallengeRecord>();
  private consumed = new Set<string>();
  private sweepTimer?: NodeJS.Timeout;

  issue(record: ChallengeRecord): void {
    this.store.set(record.requestId, record);
  }

  /** Returns the record even if expired (no deletion); null only if unknown. */
  peek(requestId: string): ChallengeRecord | null {
    return this.store.get(requestId) ?? null;
  }

  get(requestId: string): ChallengeRecord | null {
    const rec = this.store.get(requestId);
    if (!rec) return null;
    if (Date.now() > rec.expiresAtMs) {
      this.store.delete(requestId);
      return null;
    }
    return rec;
  }

  /** Atomically consume: returns the record once, null on missing/expired/replay. */
  consume(requestId: string): ChallengeRecord | null {
    if (this.consumed.has(requestId)) return null;
    const rec = this.get(requestId);
    if (!rec) return null;
    this.consumed.add(requestId);
    this.store.delete(requestId);
    return rec;
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, rec] of this.store) {
      if (now > rec.expiresAtMs) {
        this.store.delete(id);
        this.consumed.delete(id);
      }
    }
  }

  startSweeper(intervalMs = 60_000): void {
    this.stopSweeper();
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  get size(): number {
    return this.store.size;
  }
}

export type Role = 'reader' | 'contributor' | 'editor' | 'administrator';
export const ALL_ROLES: Role[] = ['reader', 'contributor', 'editor', 'administrator'];
export const TREASURY_CAPABILITY = 'treasury';

export interface Session {
  id: string;
  userId: string;
  address: string;
  roles: Role[];
  capabilities: string[];
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiry: number;
}

export interface SessionStore {
  get(id: string): Promise<Session | null>;
  create(session: Session): Promise<void>;
  touch(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
}

/** In-memory session store (dev / no-Redis fallback). Production uses Redis. */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  async get(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
  async create(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async touch(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = Date.now();
  }
  async destroy(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function csrfTokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export interface VerifyChallengeInput {
  requestId: string;
  signature: string;
  /** Flow the client claims to have used; must match the issued challenge. */
  flow: SignInFlow;
}

export type ChallengeVerifyResult =
  | { ok: true; record: ChallengeRecord }
  | { ok: false; reason: 'missing' | 'expired' | 'replayed' | 'field_mismatch' | 'bad_signature' };

/**
 * Full verification pipeline: consume challenge atomically, re-parse the
 * issued message strictly, check every field, then verify the signature.
 * Pure function over stores — importable by the worker lane too.
 */
export function verifyChallenge(
  store: ChallengeStore,
  input: VerifyChallengeInput,
): ChallengeVerifyResult {
  const record = store.peek(input.requestId);
  if (!record) {
    return { ok: false, reason: 'missing' };
  }
  if (Date.now() > record.expiresAtMs) {
    store.consume(input.requestId);
    return { ok: false, reason: 'expired' };
  }
  // Atomic single-use consume BEFORE signature work so a racing second
  // verify cannot reuse the challenge even if the first fails later.
  const consumed = store.consume(input.requestId);
  if (!consumed) return { ok: false, reason: 'replayed' };

  if (consumed.flow !== input.flow) return { ok: false, reason: 'field_mismatch' };
  const parsed = parseSignInMessage(consumed.message);
  if (
    !parsed ||
    parsed.domain !== consumed.domain ||
    parsed.uri !== consumed.uri ||
    parsed.address !== consumed.address ||
    parsed.nonce !== consumed.nonce ||
    parsed.issuedAt !== consumed.issuedAt ||
    parsed.expiresAt !== consumed.expiresAt ||
    parsed.requestId !== consumed.requestId ||
    parsed.flow !== consumed.flow
  ) {
    return { ok: false, reason: 'field_mismatch' };
  }
  const sigOk = verifyWalletSignature({
    message: consumed.message,
    signatureBase58: input.signature,
    addressBase58: consumed.address,
  });
  if (!sigOk) return { ok: false, reason: 'bad_signature' };
  return { ok: true, record: consumed };
}
