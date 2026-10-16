/**
 * Real @afterbyte/solana adapter for the worker.
 *
 * Implements the SolanaPackage interface (moved here from src/shims/solana.ts
 * when the shims were deleted) backed by the real @afterbyte/solana package.
 * Canonicalization is NEVER reimplemented here — it is delegated to the
 * package's hashPayload/deriveObjectKey (ADR-0002).
 *
 * Honest behaviors:
 * - canonicalizePublicationPayload is pure and always available.
 * - deriveReceiptAddress throws loudly when RECEIPT_PROGRAM_ID is unset.
 * - RPC methods throw on transport/RPC errors; the reconciler's
 *   withRpcFallback tries the next RPC. No RPC configured is handled by the
 *   reconciler (receipt -> 'unavailable'), never by inventing a result.
 * - submitAnchor resolves previousPayloadHash from the on-chain Subject
 *   account (missing subject -> v1 zero hash; otherwise the administrator
 *   must have called initialize_subject — the publisher cannot).
 * - submitAnchor requires an injected SignFn. When none is configured it
 *   throws PublisherSigningUnavailableError naming the missing setup.
 *   PUBLISHER_KEYPAIR_PATH enables a local-dev file-backed signer only.
 */

import {
  hashPayload,
  deriveObjectKey,
  HASH_SCHEMA_VERSION,
  deriveSubjectId,
  receiptProgramId,
  findConfigPda,
  findPublisherPda,
  findSubjectPda,
  findReceiptPda,
  buildAppendReceiptTx,
  publicationKindToU8,
  parseReceiptAccount,
  parseSubjectAccount,
  RestrictedPublisherSigner,
  loadPublisherSignerReference,
  type PublicationKindLabel,
  type SignFn,
} from '@afterbyte/solana';
import { PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import type { Logger } from '../logging.js';

export interface CanonicalizationResult {
  /** UTF-8 bytes of the JCS document. */
  canonicalBytes: Uint8Array;
  /** Lowercase hex SHA-256 of canonicalBytes. */
  payloadHash: string;
  /** Content-addressed storage key, e.g. `receipts/canonical/v1/sha256:<hex>.json`. */
  objectKey: string;
  /** Hash scheme version from ADR-0002 (currently 1). */
  hashSchemaVersion: number;
}

export interface SubmitAnchorArgs {
  subjectId: string;
  versionNumber: number;
  payloadHash: string;
  /**
   * Publication kind label ('initial' | 'amendment' | 'correction' | 'retraction').
   * Required by the on-chain instruction; the anchor-receipt job carries it
   * from the draft's canonical payload. The adapter throws loudly when absent.
   */
  publicationKind?: PublicationKindLabel;
  /**
   * Optional override. When absent, the adapter reads the on-chain Subject
   * account (or uses the 32-byte zero hash for v1).
   */
  previousPayloadHash?: string;
}

export interface SolanaPackage {
  canonicalizePublicationPayload(
    payload: Record<string, unknown>,
  ): CanonicalizationResult;
  /**
   * Derive the deterministic receipt PDA for (subject, version).
   * Brief §10: fixed namespace seeds, documented integer encoding.
   */
  deriveReceiptAddress(subjectId: string, versionNumber: number): Promise<string>;
  /**
   * Read a receipt account. Returns null when the account does not exist.
   * Used by the reconciler BEFORE retrying a timed-out submission.
   */
  getReceiptAccount(
    rpcUrl: string,
    receiptAddress: string,
  ): Promise<{ payloadHash: string; versionNumber: number } | null>;
  /**
   * Get signature confirmation status. Returns null when the signature is
   * unknown to the RPC node (never seen / expired from history).
   */
  getSignatureStatus(
    rpcUrl: string,
    signature: string,
  ): Promise<
    | { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; slot: number; err: unknown }
    | null
  >;
  /**
   * Submit an append_receipt transaction for an approved payload/version.
   * The publisher-signing boundary lives inside @afterbyte/solana; the worker
   * never sees private keys.
   */
  submitAnchor(
    rpcUrl: string,
    args: SubmitAnchorArgs,
  ): Promise<{ signature: string }>;
}

export class PublisherSigningUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `publisher signing unavailable: ${detail}. ` +
        `Set PUBLISHER_KEYPAIR_PATH to a local keypair JSON file for dev, or inject a SignFn via createSolanaAdapter({ sign }).`,
    );
    this.name = 'PublisherSigningUnavailableError';
  }
}

const ZERO_HASH = new Uint8Array(32);
const HEX64 = /^[0-9a-fA-F]{64}$/;

function hexToBytes(hex: string, what: string): Uint8Array {
  if (!HEX64.test(hex)) throw new Error(`${what} must be 64 hex characters`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${rpcUrl}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string; code?: number } };
  if (body.error) {
    throw new Error(`RPC error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown'}`.trim());
  }
  return body.result;
}

async function rpcGetAccountData(rpcUrl: string, addressB58: string): Promise<Uint8Array | null> {
  const result = (await rpcCall(rpcUrl, 'getAccountInfo', [
    addressB58,
    { encoding: 'base64', commitment: 'finalized' },
  ])) as { value: null | { data: [string, string] } };
  const v = result?.value;
  if (!v) return null;
  return Uint8Array.from(Buffer.from(v.data[0], 'base64'));
}

/**
 * Dev-only file-backed signer. PUBLISHER_KEYPAIR_PATH points at a JSON file
 * containing a 32- or 64-number array (solana-keygen format). Refused in
 * production unless PUBLISHER_ALLOW_FILE_SIGNER=1 is explicitly set.
 */
export function loadDevSignFn(logger?: Logger): SignFn | undefined {
  const path = process.env.PUBLISHER_KEYPAIR_PATH;
  if (!path) return undefined;
  if (process.env.APP_ENV === 'production' && process.env.PUBLISHER_ALLOW_FILE_SIGNER !== '1') {
    throw new Error(
      'PUBLISHER_KEYPAIR_PATH is set but file-backed publisher signing is refused in production ' +
        '(set PUBLISHER_ALLOW_FILE_SIGNER=1 to override, or inject a KMS-backed SignFn)',
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  const secret = Uint8Array.from(raw);
  const keypair =
    secret.length === 64 ? Keypair.fromSecretKey(secret) : Keypair.fromSeed(secret.slice(0, 32));
  logger?.warn('using file-backed publisher signer (dev only)', { publicKey: keypair.publicKey.toBase58() });
  return async (tx: Transaction) => {
    tx.sign(keypair);
    return tx;
  };
}

export interface SolanaAdapterOptions {
  /** Host-provided signing callback. The raw key lives with the host, never here. */
  sign?: SignFn;
  /** Maximum total fee (lamports) the signer will ever pay per transaction. */
  maxFeeLamports?: number;
  logger?: Logger;
}

export function createSolanaAdapter(opts: SolanaAdapterOptions = {}): SolanaPackage {
  const sign = opts.sign ?? loadDevSignFn(opts.logger);
  const maxFeeLamports = opts.maxFeeLamports ?? 100_000;
  const logger = opts.logger;

  return {
    canonicalizePublicationPayload(payload: Record<string, unknown>): CanonicalizationResult {
      const { bytes, hex } = hashPayload(payload);
      return {
        canonicalBytes: bytes,
        payloadHash: hex,
        objectKey: deriveObjectKey(hex),
        hashSchemaVersion: HASH_SCHEMA_VERSION,
      };
    },

    async deriveReceiptAddress(subjectId: string, versionNumber: number): Promise<string> {
      const programId = receiptProgramId(); // throws loudly when unconfigured
      const { bytes } = deriveSubjectId(subjectId);
      const [pda] = findReceiptPda(bytes, versionNumber, programId);
      return pda.toBase58();
    },

    async getReceiptAccount(rpcUrl: string, receiptAddress: string) {
      const data = await rpcGetAccountData(rpcUrl, receiptAddress);
      if (!data) return null;
      const parsed = parseReceiptAccount(data);
      return {
        payloadHash: Buffer.from(parsed.payloadHash).toString('hex'),
        versionNumber: Number(parsed.version),
      };
    },

    async getSignatureStatus(rpcUrl: string, signature: string) {
      const result = (await rpcCall(rpcUrl, 'getSignatureStatuses', [
        [signature],
        { searchTransactionHistory: true },
      ])) as { value: Array<null | { slot: number; confirmations: number | null; err: unknown; confirmationStatus: string | null }> };
      const v = result?.value?.[0] ?? null;
      if (!v) return null;
      const status = (v.confirmationStatus ?? 'processed') as 'processed' | 'confirmed' | 'finalized';
      return { confirmationStatus: status, slot: v.slot, err: v.err ?? null };
    },

    async submitAnchor(rpcUrl: string, args: SubmitAnchorArgs): Promise<{ signature: string }> {
      if (!sign) {
        throw new PublisherSigningUnavailableError('no SignFn configured');
      }
      if (!args.publicationKind) {
        throw new Error(
          'submitAnchor: publicationKind is required — the anchor-receipt job must carry it from the draft canonical payload',
        );
      }
      const programId = receiptProgramId();
      const publisherRef = loadPublisherSignerReference();
      const { bytes: subjectId32 } = deriveSubjectId(args.subjectId);
      const payloadHashBytes = hexToBytes(args.payloadHash, 'payloadHash');

      const [configPda] = findConfigPda(programId);
      const [subjectPda] = findSubjectPda(subjectId32, programId);
      const [receiptPda] = findReceiptPda(subjectId32, args.versionNumber, programId);

      // Read the on-chain config for the governing schema version.
      const configData = await rpcGetAccountData(rpcUrl, configPda.toBase58());
      if (!configData || configData.length < 10) {
        throw new Error('receipt program config account not initialized on this cluster');
      }
      const schemaVersion = configData[8]! | (configData[9]! << 8);

      // Resolve previousPayloadHash from the Subject account (source of truth).
      let previousPayloadHash: Uint8Array;
      const subjectData = await rpcGetAccountData(rpcUrl, subjectPda.toBase58());
      if (!subjectData) {
        if (args.versionNumber !== 1) {
          throw new Error(
            `subject PDA ${subjectPda.toBase58()} not initialized and versionNumber is ${args.versionNumber} — ` +
              `an administrator must call initialize_subject before the first append`,
          );
        }
        previousPayloadHash = ZERO_HASH;
      } else {
        const parsed = parseSubjectAccount(subjectData);
        if (Number(parsed.latestVersion) + 1 !== args.versionNumber) {
          throw new Error(
            `version gap: on-chain latest_version is ${parsed.latestVersion}, requested ${args.versionNumber}`,
          );
        }
        previousPayloadHash = args.previousPayloadHash
          ? hexToBytes(args.previousPayloadHash, 'previousPayloadHash')
          : parsed.latestReceiptHash;
      }

      const kindU8 = publicationKindToU8(args.publicationKind);

      // The publisher key: derive from the signer reference when it is a
      // base58 pubkey (dev), otherwise the host's SignFn signs as the
      // configured publisher and we read it from the signed transaction.
      // For the allowlisted instruction we need the pubkey up-front, so the
      // reference must resolve to a pubkey here.
      let publisher: PublicKey;
      try {
        publisher = new PublicKey(publisherRef);
      } catch {
        throw new PublisherSigningUnavailableError(
          `PUBLISHER_SIGNER_REFERENCE is not a base58 pubkey (${publisherRef}); ` +
            `the adapter needs the publisher pubkey to build the allowlisted instruction`,
        );
      }
      const [publisherAuthPda] = findPublisherPda(publisher, programId);

      const tx = buildAppendReceiptTx({
        programId,
        config: configPda,
        subject: subjectPda,
        receipt: receiptPda,
        publisherAuth: publisherAuthPda,
        publisher,
        args: {
          subjectId: subjectId32,
          version: args.versionNumber,
          payloadHash: payloadHashBytes,
          previousPayloadHash,
          publicationKind: kindU8,
          schemaVersion,
        },
      });

      const latest = (await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'finalized' }])) as {
        value: { blockhash: string };
      };
      tx.recentBlockhash = latest.value.blockhash;

      const signer = new RestrictedPublisherSigner({
        programId,
        publisher,
        maxFeeLamports,
        sign,
      });
      const approved = {
        subjectId: subjectId32,
        version: args.versionNumber,
        payloadHash: payloadHashBytes,
        previousPayloadHash,
        publicationKind: kindU8,
        schemaVersion,
      };
      const signed = await signer.signAppendReceipt(tx, approved);

      const raw = signed.serialize();
      const signature = (await rpcCall(rpcUrl, 'sendTransaction', [
        Buffer.from(raw).toString('base64'),
        { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3 },
      ])) as string;
      if (typeof signature !== 'string' || signature.length === 0) {
        throw new Error('sendTransaction returned no signature');
      }
      logger?.info('append_receipt submitted', {
        signature,
        subjectId: args.subjectId,
        versionNumber: args.versionNumber,
      });
      return { signature };
    },
  };
}
