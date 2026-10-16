/**
 * RESTRICTED publisher signing boundary.
 *
 * The publisher signer is NOT a general transaction signer. It will only sign
 * transactions that satisfy ALL of the following:
 *  1. Every instruction targets the receipt program id (no other programs).
 *  2. Every instruction is the `append_receipt` instruction (publisher role
 *     never signs admin instructions — those need the separate admin key).
 *  3. The decoded append_receipt args EXACTLY match the approved
 *     subject/version/payload hashes/kind/schema the caller passed in.
 *  4. The only required signer is the publisher itself.
 *  5. The fee payer is the publisher (set automatically if unset).
 *  6. Any ComputeBudget price instruction implies a fee within
 *     `maxFeeLamports` (bounded fees).
 *
 * Key material: this module never holds a raw key. The host injects a
 * `sign(tx)` callback wired to its own custody (HSM/KMS/local signer). The key
 * *reference* (not the key) comes from the `PUBLISHER_SIGNER_REFERENCE` env
 * var — e.g. a KMS key ARN or HSM slot label. There is intentionally no
 * general arbitrary-transaction signing endpoint in this package.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { instructionDiscriminator, publicationKindToU8 } from "./client.js";
import type { PublicationKindLabel } from "./client.js";

const APPEND_IX_DATA_LEN = 8 + 107; // discriminator + borsh args
const DEFAULT_COMPUTE_UNITS = 200_000; // network default when no limit is set
const LAMPORTS_PER_SIGNATURE = 5_000; // base tx cost, counted in the bound

export interface ApprovedAppend {
  subjectId: Uint8Array;
  version: number | bigint;
  payloadHash: Uint8Array;
  previousPayloadHash: Uint8Array;
  publicationKind: PublicationKindLabel | number;
  schemaVersion: number;
}

/** Host-provided signing callback. The raw key lives with the host, never here. */
export type SignFn = (tx: Transaction) => Promise<Transaction>;

export interface RestrictedSignerConfig {
  programId: PublicKey;
  /** The authorized publisher key this signer acts as. */
  publisher: PublicKey;
  /** Maximum total fee (lamports) this signer will ever pay per transaction. */
  maxFeeLamports: number;
  sign: SignFn;
}

/**
 * Load the publisher key *reference* from the environment. This is a pointer
 * (KMS ARN, HSM label, …) — never a raw private key.
 */
export function loadPublisherSignerReference(): string {
  const ref = process.env.PUBLISHER_SIGNER_REFERENCE;
  if (!ref) {
    throw new Error(
      "PUBLISHER_SIGNER_REFERENCE is not set — publisher signing is unavailable"
    );
  }
  return ref;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const APPEND_DISCRIMINATOR = instructionDiscriminator("append_receipt");

interface DecodedAppend {
  subjectId: Uint8Array;
  version: bigint;
  payloadHash: Uint8Array;
  previousPayloadHash: Uint8Array;
  publicationKind: number;
  schemaVersion: number;
}

function decodeAppendIx(ix: TransactionInstruction): DecodedAppend {
  const data = ix.data;
  if (data.length !== APPEND_IX_DATA_LEN) {
    throw new Error(`append_receipt: unexpected data length ${data.length}`);
  }
  return {
    subjectId: data.subarray(8, 40),
    version: data.readBigUInt64LE(40),
    payloadHash: data.subarray(48, 80),
    previousPayloadHash: data.subarray(80, 112),
    publicationKind: data.readUInt8(112),
    schemaVersion: data.readUInt16LE(113),
  };
}

/**
 * Bound the fee implied by ComputeBudget instructions.
 * Returns the total estimated fee in lamports (base + priority).
 */
function estimateFeeLamports(ixs: TransactionInstruction[]): number {
  let microLamports = 0n;
  let units = DEFAULT_COMPUTE_UNITS;
  let limitSet = false;
  for (const ix of ixs) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    const tag = ix.data.readUInt8(0);
    if (tag === 3) {
      // SetComputeUnitPrice { micro_lamports: u64 }
      microLamports = ix.data.readBigUInt64LE(1);
    } else if (tag === 2) {
      // SetComputeUnitLimit { units: u32 }
      units = ix.data.readUInt32LE(1);
      limitSet = true;
    } else if (tag === 0) {
      throw new Error("signer: deprecated ComputeBudget::RequestUnits not allowed");
    }
  }
  void limitSet;
  const priorityFee = Number((microLamports * BigInt(units)) / 1_000_000n);
  return LAMPORTS_PER_SIGNATURE + priorityFee;
}

export class RestrictedPublisherSigner {
  private readonly programId: PublicKey;
  private readonly publisher: PublicKey;
  private readonly maxFeeLamports: number;
  private readonly sign: SignFn;

  constructor(config: RestrictedSignerConfig) {
    if (!Number.isFinite(config.maxFeeLamports) || config.maxFeeLamports <= 0) {
      throw new Error("maxFeeLamports must be a positive number");
    }
    this.programId = config.programId;
    this.publisher = config.publisher;
    this.maxFeeLamports = config.maxFeeLamports;
    this.sign = config.sign;
  }

  /**
   * Verify a transaction against the allowlist + approved append, then sign.
   * Throws on ANY violation — nothing is signed unless everything checks out.
   */
  async signAppendReceipt(unsignedTx: Transaction, expected: ApprovedAppend): Promise<Transaction> {
    const ixs = unsignedTx.instructions;
    if (ixs.length === 0) throw new Error("signer: transaction has no instructions");

    const expectedKind =
      typeof expected.publicationKind === "number"
        ? expected.publicationKind
        : publicationKindToU8(expected.publicationKind);

    for (const ix of ixs) {
      // ComputeBudget instructions are allowlisted separately: only the known
      // limit/price/heap tags, with the fee bounded below.
      if (ix.programId.equals(ComputeBudgetProgram.programId)) {
        // Real ComputeBudget tags: 0=RequestUnits(deprecated), 1=RequestHeapFrame,
        // 2=SetComputeUnitLimit, 3=SetComputeUnitPrice.
        const tag = ix.data.length > 0 ? ix.data.readUInt8(0) : 255;
        if (tag !== 1 && tag !== 2 && tag !== 3) {
          throw new Error("signer: unexpected ComputeBudget instruction");
        }
        continue;
      }
      // (1) Program allowlist: receipt program only.
      if (!ix.programId.equals(this.programId)) {
        throw new Error(
          `signer: instruction targets non-allowlisted program ${ix.programId.toBase58()}`
        );
      }
      // (2) Instruction allowlist: append_receipt only for the publisher role.
      if (!bytesEqual(ix.data.subarray(0, 8), APPEND_DISCRIMINATOR)) {
        throw new Error("signer: only append_receipt instructions are signable by the publisher");
      }
      // (3) Approved payload/version check: decode and compare every field.
      const decoded = decodeAppendIx(ix);
      if (!bytesEqual(decoded.subjectId, expected.subjectId)) {
        throw new Error("signer: subjectId does not match the approved append");
      }
      if (decoded.version !== BigInt(expected.version)) {
        throw new Error("signer: version does not match the approved append");
      }
      if (!bytesEqual(decoded.payloadHash, expected.payloadHash)) {
        throw new Error("signer: payloadHash does not match the approved append");
      }
      if (!bytesEqual(decoded.previousPayloadHash, expected.previousPayloadHash)) {
        throw new Error("signer: previousPayloadHash does not match the approved append");
      }
      if (decoded.publicationKind !== expectedKind) {
        throw new Error("signer: publicationKind does not match the approved append");
      }
      if (decoded.schemaVersion !== expected.schemaVersion) {
        throw new Error("signer: schemaVersion does not match the approved append");
      }
    }

    // (4) No foreign signers may be required.
    for (const ix of ixs) {
      for (const key of ix.keys) {
        if (key.isSigner && !key.pubkey.equals(this.publisher)) {
          throw new Error(`signer: transaction requires foreign signer ${key.pubkey.toBase58()}`);
        }
      }
    }

    // (5) Fee payer must be the publisher.
    if (unsignedTx.feePayer) {
      if (!unsignedTx.feePayer.equals(this.publisher)) {
        throw new Error("signer: feePayer must be the publisher");
      }
    } else {
      unsignedTx.feePayer = this.publisher;
    }

    // (6) Bounded fees.
    const fee = estimateFeeLamports(ixs);
    if (fee > this.maxFeeLamports) {
      throw new Error(
        `signer: estimated fee ${fee} lamports exceeds bound ${this.maxFeeLamports}`
      );
    }

    return this.sign(unsignedTx);
  }
}
