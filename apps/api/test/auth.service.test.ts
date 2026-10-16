import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  buildSignInMessage,
  parseSignInMessage,
  verifyWalletSignature,
  isValidSolanaAddress,
  ChallengeStore,
  verifyChallenge,
  newRequestId,
  type ChallengeRecord,
} from '../src/services/auth.service.js';

function keypair() {
  const kp = nacl.sign.keyPair();
  return { kp, address: bs58.encode(kp.publicKey) };
}

const baseInput = {
  domain: 'api.afterbyte.example',
  uri: 'https://api.afterbyte.example/api/v1/auth/verify',
  address: '11111111111111111111111111111111',
  nonce: 'abc123',
  issuedAt: '2026-10-16T09:00:00.000Z',
  expiresAt: '2026-10-16T09:05:00.000Z',
  requestId: 'req-1',
  flow: 'solana-sign-in' as const,
};

describe('sign-in message', () => {
  it('round-trips through strict parsing', () => {
    const msg = buildSignInMessage(baseInput);
    const parsed = parseSignInMessage(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.domain).toBe(baseInput.domain);
    expect(parsed!.address).toBe(baseInput.address);
    expect(parsed!.flow).toBe('solana-sign-in');
  });

  it('rejects any deviation from the canonical format', () => {
    const msg = buildSignInMessage(baseInput);
    expect(parseSignInMessage(msg + '\nextra line')).toBeNull();
    expect(parseSignInMessage(msg.replace('Address: ', 'address: '))).toBeNull();
    expect(parseSignInMessage(msg.replace('2026-10-16T09:05:00.000Z', 'tomorrow'))).toBeNull();
    expect(parseSignInMessage('garbage')).toBeNull();
  });

  it('supports the sign-message flow variant', () => {
    const msg = buildSignInMessage({ ...baseInput, flow: 'sign-message' });
    expect(parseSignInMessage(msg)!.flow).toBe('sign-message');
  });
});

describe('wallet signature verification', () => {
  it('verifies a real ed25519 signature and rejects tampering', () => {
    const { kp, address } = keypair();
    const message = buildSignInMessage({ ...baseInput, address });
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
    expect(verifyWalletSignature({ message, signatureBase58: sig, addressBase58: address })).toBe(true);
    expect(
      verifyWalletSignature({ message: message + '!', signatureBase58: sig, addressBase58: address }),
    ).toBe(false);
    const other = keypair();
    expect(verifyWalletSignature({ message, signatureBase58: sig, addressBase58: other.address })).toBe(false);
  });

  it('never throws on malformed inputs', () => {
    expect(verifyWalletSignature({ message: 'x', signatureBase58: '!!!', addressBase58: 'abc' })).toBe(false);
    expect(verifyWalletSignature({ message: 'x', signatureBase58: bs58.encode(new Uint8Array(64)), addressBase58: 'abc' })).toBe(false);
  });

  it('validates solana address shape', () => {
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isValidSolanaAddress('not-an-address')).toBe(false);
  });
});

function makeRecord(overrides: Partial<ChallengeRecord> = {}): ChallengeRecord {
  const requestId = overrides.requestId ?? newRequestId();
  const address = overrides.address ?? baseInput.address;
  const message =
    overrides.message ??
    buildSignInMessage({
      domain: baseInput.domain,
      uri: baseInput.uri,
      address,
      nonce: baseInput.nonce,
      issuedAt: baseInput.issuedAt,
      expiresAt: baseInput.expiresAt,
      requestId,
      flow: 'solana-sign-in',
    });
  return {
    requestId,
    domain: baseInput.domain,
    uri: baseInput.uri,
    address,
    nonce: baseInput.nonce,
    issuedAt: baseInput.issuedAt,
    expiresAt: baseInput.expiresAt,
    message,
    flow: 'solana-sign-in',
    expiresAtMs: Date.now() + 5 * 60 * 1000,
    ...overrides,
  };
}

describe('challenge store', () => {
  it('consumes atomically: single use only', () => {
    const store = new ChallengeStore();
    const rec = makeRecord();
    store.issue(rec);
    expect(store.consume(rec.requestId)).not.toBeNull();
    expect(store.consume(rec.requestId)).toBeNull(); // replay rejected
  });

  it('expires challenges', () => {
    const store = new ChallengeStore();
    const rec = makeRecord({ expiresAtMs: Date.now() - 1 });
    store.issue(rec);
    expect(store.get(rec.requestId)).toBeNull();
    expect(store.consume(rec.requestId)).toBeNull();
  });
});

describe('verifyChallenge pipeline', () => {
  it('accepts a fully valid challenge+signature', () => {
    const { kp, address } = keypair();
    const store = new ChallengeStore();
    const rec = makeRecord({ address });
    store.issue(rec);
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(rec.message), kp.secretKey));
    const result = verifyChallenge(store, { requestId: rec.requestId, signature: sig, flow: 'solana-sign-in' });
    expect(result.ok).toBe(true);
    // consumed: second attempt is a replay
    const again = verifyChallenge(store, { requestId: rec.requestId, signature: sig, flow: 'solana-sign-in' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('missing');
  });

  it('rejects wrong flow, bad signature, and expired challenges', () => {
    const { kp, address } = keypair();
    const store = new ChallengeStore();

    const r1 = makeRecord({ address });
    store.issue(r1);
    const goodSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(r1.message), kp.secretKey));
    const wrongFlow = verifyChallenge(store, { requestId: r1.requestId, signature: goodSig, flow: 'sign-message' });
    expect(wrongFlow.ok).toBe(false);
    if (!wrongFlow.ok) expect(wrongFlow.reason).toBe('field_mismatch');

    const r2 = makeRecord({ address });
    store.issue(r2);
    const badSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode('something else'), kp.secretKey));
    const bad = verifyChallenge(store, { requestId: r2.requestId, signature: badSig, flow: 'solana-sign-in' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('bad_signature');

    const r3 = makeRecord({ address, expiresAtMs: Date.now() - 1 });
    store.issue(r3);
    const res3 = verifyChallenge(store, { requestId: r3.requestId, signature: goodSig, flow: 'solana-sign-in' });
    expect(res3.ok).toBe(false);
    if (!res3.ok) expect(res3.reason).toBe('expired');
  });
});
