/**
 * Tests for the deterministic program client: PDA derivation, instruction
 * discriminators, borsh arg encoding, and instruction builder account metas.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  buildAppendReceiptIx,
  buildInitializeConfigIx,
  buildPauseIx,
  encodeAppendReceiptArgs,
  findConfigPda,
  findPublisherPda,
  findReceiptPda,
  findSubjectPda,
  instructionDiscriminator,
  publicationKindFromU8,
  publicationKindToU8,
  CONFIG_SPACE,
  PUBLISHER_SPACE,
  RECEIPT_SPACE,
  SUBJECT_SPACE,
} from "../src/client.js";
import { deriveSubjectId } from "../src/canonicalize.js";

const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLn"); // placeholder
const SUBJECT_ID = deriveSubjectId("9b2f3c1d-4a5e-6b7c-8d9e-0f1a2b3c4d5e").bytes;
const PUBLISHER = Keypair.generate().publicKey;

describe("PDA derivation", () => {
  it("is deterministic for identical inputs", () => {
    const [a] = findReceiptPda(SUBJECT_ID, 1, PROGRAM_ID);
    const [b] = findReceiptPda(SUBJECT_ID, 1, PROGRAM_ID);
    expect(a.equals(b)).toBe(true);
  });

  it("changes the receipt PDA when the version changes (u64 LE seed)", () => {
    const [v1] = findReceiptPda(SUBJECT_ID, 1, PROGRAM_ID);
    const [v2] = findReceiptPda(SUBJECT_ID, 2, PROGRAM_ID);
    expect(v1.equals(v2)).toBe(false);
  });

  it("changes the receipt PDA when the subject changes", () => {
    const other = deriveSubjectId("other-subject").bytes;
    const [a] = findReceiptPda(SUBJECT_ID, 1, PROGRAM_ID);
    const [b] = findReceiptPda(other, 1, PROGRAM_ID);
    expect(a.equals(b)).toBe(false);
  });

  it("derives config/publisher/subject PDAs deterministically", () => {
    const [c1] = findConfigPda(PROGRAM_ID);
    const [c2] = findConfigPda(PROGRAM_ID);
    expect(c1.equals(c2)).toBe(true);
    const [p1] = findPublisherPda(PUBLISHER, PROGRAM_ID);
    const [p2] = findPublisherPda(PUBLISHER, PROGRAM_ID);
    expect(p1.equals(p2)).toBe(true);
    const [s1] = findSubjectPda(SUBJECT_ID, PROGRAM_ID);
    const [s2] = findSubjectPda(SUBJECT_ID, PROGRAM_ID);
    expect(s1.equals(s2)).toBe(true);
  });

  it("rejects non-32-byte subject ids", () => {
    expect(() => findReceiptPda(new Uint8Array(31), 1, PROGRAM_ID)).toThrow();
    expect(() => findSubjectPda(new Uint8Array(33), PROGRAM_ID)).toThrow();
  });

  it("matches the manual seed construction (fixed namespace + u64 LE)", () => {
    const versionLe = Buffer.alloc(8);
    versionLe.writeBigUInt64LE(1n);
    const [manual] = PublicKey.findProgramAddressSync(
      [Buffer.from("afterbyte-receipt", "utf8"), Buffer.from(SUBJECT_ID), versionLe],
      PROGRAM_ID
    );
    const [derived] = findReceiptPda(SUBJECT_ID, 1, PROGRAM_ID);
    expect(derived.equals(manual)).toBe(true);
  });
});

describe("account spaces", () => {
  it("matches the Rust layout constants (77/42/81/164)", () => {
    expect(CONFIG_SPACE).toBe(77);
    expect(PUBLISHER_SPACE).toBe(42);
    expect(SUBJECT_SPACE).toBe(81);
    expect(RECEIPT_SPACE).toBe(164);
  });
});

describe("instruction discriminators", () => {
  it("is 8 bytes and matches the Anchor formula on fixed vectors", () => {
    // sha256("global:append_receipt")[0..8] — computed independently.
    expect(instructionDiscriminator("append_receipt").toString("hex")).toBe("1379e5d7ff4196b9");
    expect(instructionDiscriminator("initialize_config").toString("hex")).toBe("d07f1501c2bec446");
    const expected = createHash("sha256").update("global:pause", "utf8").digest().subarray(0, 8);
    expect(instructionDiscriminator("pause").equals(expected)).toBe(true);
  });

  it("differs per instruction", () => {
    const names = ["initialize_config", "append_receipt", "pause", "rotate_admin", "accept_admin"];
    const discs = names.map((n) => instructionDiscriminator(n).toString("hex"));
    expect(new Set(discs).size).toBe(names.length);
  });
});

describe("publication kinds", () => {
  it("round-trips the documented mapping", () => {
    expect(publicationKindToU8("initial")).toBe(0);
    expect(publicationKindToU8("amendment")).toBe(1);
    expect(publicationKindToU8("correction")).toBe(2);
    expect(publicationKindToU8("retraction")).toBe(3);
    expect(publicationKindFromU8(2)).toBe("correction");
    expect(() => publicationKindFromU8(9)).toThrow();
  });
});

describe("append_receipt arg encoding", () => {
  const args = {
    subjectId: SUBJECT_ID,
    version: 7,
    payloadHash: new Uint8Array(32).fill(8),
    previousPayloadHash: new Uint8Array(32).fill(0),
    publicationKind: "correction" as const,
    schemaVersion: 1,
  };

  it("encodes to 107 bytes with the documented layout", () => {
    const enc = encodeAppendReceiptArgs(args);
    expect(enc.length).toBe(107);
    expect(enc.subarray(0, 32).equals(Buffer.from(SUBJECT_ID))).toBe(true);
    expect(enc.readBigUInt64LE(32)).toBe(7n); // version u64 LE
    expect(enc.subarray(40, 72).equals(Buffer.alloc(32, 8))).toBe(true);
    expect(enc.subarray(72, 104).equals(Buffer.alloc(32, 0))).toBe(true);
    expect(enc.readUInt8(104)).toBe(2); // correction
    expect(enc.readUInt16LE(105)).toBe(1); // schemaVersion u16 LE
  });

  it("rejects out-of-range kind discriminants", () => {
    expect(() => encodeAppendReceiptArgs({ ...args, publicationKind: 9 })).toThrow();
  });
});

describe("instruction builders", () => {
  it("builds initialize_config with admin as writable signer", () => {
    const admin = Keypair.generate().publicKey;
    const [config] = findConfigPda(PROGRAM_ID);
    const ix = buildInitializeConfigIx({ programId: PROGRAM_ID, config, admin, schemaVersion: 1 });
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.data.subarray(0, 8).toString("hex")).toBe("d07f1501c2bec446");
    expect(ix.data.readUInt16LE(8)).toBe(1);
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[0].pubkey.equals(config)).toBe(true);
    expect(ix.keys[1].isSigner && ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it("builds append_receipt with the publisher as signer and correct metas", () => {
    const [config] = findConfigPda(PROGRAM_ID);
    const [subject] = findSubjectPda(SUBJECT_ID, PROGRAM_ID);
    const [receipt] = findReceiptPda(SUBJECT_ID, 1, PROGRAM_ID);
    const [publisherAuth] = findPublisherPda(PUBLISHER, PROGRAM_ID);
    const ix = buildAppendReceiptIx({
      programId: PROGRAM_ID,
      config,
      subject,
      receipt,
      publisherAuth,
      publisher: PUBLISHER,
      args: {
        subjectId: SUBJECT_ID,
        version: 1,
        payloadHash: new Uint8Array(32).fill(1),
        previousPayloadHash: new Uint8Array(32).fill(0),
        publicationKind: "initial",
        schemaVersion: 1,
      },
    });
    expect(ix.data.subarray(0, 8).toString("hex")).toBe("1379e5d7ff4196b9");
    expect(ix.data.length).toBe(8 + 107);
    expect(ix.keys).toHaveLength(6);
    const [cfg, subj, rcpt, auth, pub_, sys] = ix.keys;
    expect(cfg.isWritable).toBe(false);
    expect(subj.isWritable && !subj.isSigner).toBe(true);
    expect(rcpt.isWritable && !rcpt.isSigner).toBe(true);
    expect(auth.isWritable).toBe(false);
    expect(pub_.isSigner && pub_.isWritable && pub_.pubkey.equals(PUBLISHER)).toBe(true);
    expect(sys.pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  it("builds pause with config writable and admin signer", () => {
    const admin = Keypair.generate().publicKey;
    const [config] = findConfigPda(PROGRAM_ID);
    const ix = buildPauseIx({ programId: PROGRAM_ID, config, admin });
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
  });
});
