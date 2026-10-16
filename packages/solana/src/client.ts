/**
 * Deterministic client for the afterbyte-receipts Solana program.
 *
 * Pure functions only: PDA derivation mirroring the Rust seeds
 * (`programs/afterbyte-receipts/src/lib.rs`) and instruction builders for the
 * 9 instructions. No network calls, no signing here — signing lives behind
 * the restricted boundary in signer.ts.
 *
 * Uses pinned @solana/web3.js v1 (1.95.8).
 */

import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Program id
// ---------------------------------------------------------------------------

/**
 * Receipt program id. NEVER hardcoded: it is read from RECEIPT_PROGRAM_ID and
 * is only real after an actual deployment (see the deployment manifest).
 * Access via receiptProgramId() so misconfiguration fails fast and loudly.
 */
export function receiptProgramId(): PublicKey {
  const id = process.env.RECEIPT_PROGRAM_ID;
  if (!id) {
    throw new Error(
      "RECEIPT_PROGRAM_ID is not set — the receipt program is not deployed/configured"
    );
  }
  return new PublicKey(id);
}

// ---------------------------------------------------------------------------
// PDA seeds (must match programs/afterbyte-receipts/src/lib.rs exactly)
// ---------------------------------------------------------------------------

export const SEED_CONFIG = "afterbyte-config";
export const SEED_PUBLISHER = "afterbyte-publisher";
export const SEED_SUBJECT = "afterbyte-subject";
export const SEED_RECEIPT = "afterbyte-receipt";

/** Account sizes incl. 8-byte Anchor discriminator (see BUILD.md). */
export const CONFIG_SPACE = 77;
export const PUBLISHER_SPACE = 42;
export const SUBJECT_SPACE = 81;
export const RECEIPT_SPACE = 164;

/** Publication kinds: on-chain u8 discriminant ↔ off-chain label. */
export const PUBLICATION_KINDS = {
  initial: 0,
  amendment: 1,
  correction: 2,
  retraction: 3,
} as const;
export type PublicationKindLabel = keyof typeof PUBLICATION_KINDS;

const PUBLICATION_KIND_LABELS: Record<number, PublicationKindLabel> = {
  0: "initial",
  1: "amendment",
  2: "correction",
  3: "retraction",
};

export function publicationKindToU8(label: PublicationKindLabel): number {
  const v = PUBLICATION_KINDS[label];
  if (v === undefined) throw new Error(`unknown publication kind: ${label}`);
  return v;
}

export function publicationKindFromU8(v: number): PublicationKindLabel {
  const label = PUBLICATION_KIND_LABELS[v];
  if (label === undefined) throw new Error(`unknown publication kind discriminant: ${v}`);
  return label;
}

function u64LeBytes(version: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(version));
  return b;
}

export interface Pdas {
  config: PublicKey;
  configBump: number;
  publisherAuth: PublicKey;
  publisherAuthBump: number;
  subject: PublicKey;
  subjectBump: number;
}

export function findConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(SEED_CONFIG, "utf8")], programId);
}

export function findPublisherPda(publisher: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_PUBLISHER, "utf8"), publisher.toBuffer()],
    programId
  );
}

export function findSubjectPda(subjectId32: Uint8Array, programId: PublicKey): [PublicKey, number] {
  if (subjectId32.length !== 32) throw new Error("subjectId must be 32 bytes");
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_SUBJECT, "utf8"), Buffer.from(subjectId32)],
    programId
  );
}

export function findReceiptPda(
  subjectId32: Uint8Array,
  version: number | bigint,
  programId: PublicKey
): [PublicKey, number] {
  if (subjectId32.length !== 32) throw new Error("subjectId must be 32 bytes");
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_RECEIPT, "utf8"), Buffer.from(subjectId32), u64LeBytes(version)],
    programId
  );
}

// ---------------------------------------------------------------------------
// Instruction discriminators: first 8 bytes of sha256("global:<name>")
// (Anchor convention; mirrors the Rust program's instruction names)
// ---------------------------------------------------------------------------

export const INSTRUCTION_NAMES = [
  "initialize_config",
  "authorize_publisher",
  "revoke_publisher",
  "initialize_subject",
  "append_receipt",
  "pause",
  "resume",
  "rotate_admin",
  "accept_admin",
] as const;
export type InstructionName = (typeof INSTRUCTION_NAMES)[number];

export function instructionDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`, "utf8").digest().subarray(0, 8);
}

const DISCRIMINATORS: Record<InstructionName, Buffer> = Object.fromEntries(
  INSTRUCTION_NAMES.map((n) => [n, instructionDiscriminator(n)])
) as Record<InstructionName, Buffer>;

/** All receipt-program discriminators (used by the signer allowlist). */
export function knownDiscriminators(): Buffer[] {
  return INSTRUCTION_NAMES.map((n) => DISCRIMINATORS[n]);
}

// ---------------------------------------------------------------------------
// Borsh argument encoding (little-endian, hand-rolled)
// ---------------------------------------------------------------------------

function u8(v: number): Buffer {
  const b = Buffer.alloc(1);
  b.writeUInt8(v);
  return b;
}

function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

function fixed32(v: Uint8Array): Buffer {
  if (v.length !== 32) throw new Error("expected 32 bytes");
  return Buffer.from(v);
}

function pubkeyBytes(pk: PublicKey): Buffer {
  return pk.toBuffer();
}

export interface AppendReceiptArgs {
  subjectId: Uint8Array; // 32 bytes
  version: number | bigint; // u64
  payloadHash: Uint8Array; // 32 bytes
  previousPayloadHash: Uint8Array; // 32 bytes
  publicationKind: PublicationKindLabel | number; // u8
  schemaVersion: number; // u16
}

/** Borsh-encoded append_receipt args: 32+8+32+32+1+2 = 107 bytes. */
export function encodeAppendReceiptArgs(args: AppendReceiptArgs): Buffer {
  const kind =
    typeof args.publicationKind === "number"
      ? args.publicationKind
      : publicationKindToU8(args.publicationKind);
  if (!Number.isInteger(kind) || kind < 0 || kind > 3) {
    throw new Error(`invalid publication kind discriminant: ${kind}`);
  }
  return Buffer.concat([
    fixed32(args.subjectId),
    u64LeBytes(args.version),
    fixed32(args.payloadHash),
    fixed32(args.previousPayloadHash),
    u8(kind),
    u16le(args.schemaVersion),
  ]);
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function ix(
  programId: PublicKey,
  name: InstructionName,
  args: Buffer,
  keys: TransactionInstruction["keys"]
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.concat([DISCRIMINATORS[name], args]),
  });
}

const RO = false;
const W = true;

export function buildInitializeConfigIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  admin: PublicKey;
  schemaVersion: number;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "initialize_config",
    u16le(opts.schemaVersion),
    [
      { pubkey: opts.config, isSigner: false, isWritable: W },
      { pubkey: opts.admin, isSigner: true, isWritable: W },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: RO },
    ]
  );
}

export function buildAuthorizePublisherIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  publisherAuth: PublicKey;
  publisher: PublicKey;
  admin: PublicKey;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "authorize_publisher",
    Buffer.alloc(0),
    [
      { pubkey: opts.config, isSigner: false, isWritable: RO },
      { pubkey: opts.publisherAuth, isSigner: false, isWritable: W },
      { pubkey: opts.publisher, isSigner: false, isWritable: RO },
      { pubkey: opts.admin, isSigner: true, isWritable: W },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: RO },
    ]
  );
}

export function buildRevokePublisherIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  publisherAuth: PublicKey;
  publisher: PublicKey;
  admin: PublicKey;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "revoke_publisher",
    Buffer.alloc(0),
    [
      { pubkey: opts.config, isSigner: false, isWritable: RO },
      { pubkey: opts.publisherAuth, isSigner: false, isWritable: W },
      { pubkey: opts.publisher, isSigner: false, isWritable: RO },
      { pubkey: opts.admin, isSigner: true, isWritable: RO },
    ]
  );
}

export function buildInitializeSubjectIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  subject: PublicKey;
  admin: PublicKey;
  subjectId: Uint8Array;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "initialize_subject",
    fixed32(opts.subjectId),
    [
      { pubkey: opts.config, isSigner: false, isWritable: RO },
      { pubkey: opts.subject, isSigner: false, isWritable: W },
      { pubkey: opts.admin, isSigner: true, isWritable: W },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: RO },
    ]
  );
}

export function buildAppendReceiptIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  subject: PublicKey;
  receipt: PublicKey;
  publisherAuth: PublicKey;
  publisher: PublicKey;
  args: AppendReceiptArgs;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "append_receipt",
    encodeAppendReceiptArgs(opts.args),
    [
      { pubkey: opts.config, isSigner: false, isWritable: RO },
      { pubkey: opts.subject, isSigner: false, isWritable: W },
      { pubkey: opts.receipt, isSigner: false, isWritable: W },
      { pubkey: opts.publisherAuth, isSigner: false, isWritable: RO },
      { pubkey: opts.publisher, isSigner: true, isWritable: W },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: RO },
    ]
  );
}

export function buildPauseIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  admin: PublicKey;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "pause",
    Buffer.alloc(0),
    [
      { pubkey: opts.config, isSigner: false, isWritable: W },
      { pubkey: opts.admin, isSigner: true, isWritable: RO },
    ]
  );
}

export function buildResumeIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  admin: PublicKey;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "resume",
    Buffer.alloc(0),
    [
      { pubkey: opts.config, isSigner: false, isWritable: W },
      { pubkey: opts.admin, isSigner: true, isWritable: RO },
    ]
  );
}

/** Step 1 of the two-step rotation: current admin nominates a pending admin. */
export function buildRotateAdminIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  admin: PublicKey;
  newAdmin: PublicKey;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "rotate_admin",
    pubkeyBytes(opts.newAdmin),
    [
      { pubkey: opts.config, isSigner: false, isWritable: W },
      { pubkey: opts.admin, isSigner: true, isWritable: RO },
    ]
  );
}

/** Step 2 of the two-step rotation: the pending admin accepts. */
export function buildAcceptAdminIx(opts: {
  programId: PublicKey;
  config: PublicKey;
  newAdmin: PublicKey;
}): TransactionInstruction {
  return ix(
    opts.programId,
    "accept_admin",
    Buffer.alloc(0),
    [
      { pubkey: opts.config, isSigner: false, isWritable: W },
      { pubkey: opts.newAdmin, isSigner: true, isWritable: RO },
    ]
  );
}

/**
 * Compose an append_receipt transaction. The caller sets `recentBlockhash`
 * before submission; signing happens behind the restricted signer boundary.
 */
export function buildAppendReceiptTx(opts: {
  programId: PublicKey;
  config: PublicKey;
  subject: PublicKey;
  receipt: PublicKey;
  publisherAuth: PublicKey;
  publisher: PublicKey;
  args: AppendReceiptArgs;
}): Transaction {
  const tx = new Transaction();
  tx.add(buildAppendReceiptIx(opts));
  tx.feePayer = opts.publisher;
  return tx;
}
