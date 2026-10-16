/**
 * Tests for the restricted publisher signing boundary.
 */
import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  buildAppendReceiptIx,
  buildPauseIx,
  findConfigPda,
  findPublisherPda,
  findReceiptPda,
  findSubjectPda,
} from "../src/client.js";
import { deriveSubjectId } from "../src/canonicalize.js";
import { RestrictedPublisherSigner } from "../src/signer.js";
import type { ApprovedAppend } from "../src/signer.js";

const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLn");
const PUBLISHER = Keypair.generate().publicKey;
const SUBJECT_ID = deriveSubjectId("9b2f3c1d-4a5e-6b7c-8d9e-0f1a2b3c4d5e").bytes;
const PAYLOAD_HASH = new Uint8Array(32).fill(7);
const PREV_HASH = new Uint8Array(32).fill(0);

function approved(): ApprovedAppend {
  return {
    subjectId: SUBJECT_ID,
    version: 3,
    payloadHash: PAYLOAD_HASH,
    previousPayloadHash: PREV_HASH,
    publicationKind: "initial",
    schemaVersion: 1,
  };
}

function buildTx(): Transaction {
  const [config] = findConfigPda(PROGRAM_ID);
  const [subject] = findSubjectPda(SUBJECT_ID, PROGRAM_ID);
  const [receipt] = findReceiptPda(SUBJECT_ID, 3, PROGRAM_ID);
  const [publisherAuth] = findPublisherPda(PUBLISHER, PROGRAM_ID);
  const tx = new Transaction();
  tx.add(
    buildAppendReceiptIx({
      programId: PROGRAM_ID,
      config,
      subject,
      receipt,
      publisherAuth,
      publisher: PUBLISHER,
      args: { ...approved(), publicationKind: "initial" },
    })
  );
  return tx;
}

function makeSigner(maxFeeLamports = 100_000): RestrictedPublisherSigner {
  return new RestrictedPublisherSigner({
    programId: PROGRAM_ID,
    publisher: PUBLISHER,
    maxFeeLamports,
    sign: async (tx) => tx, // host custody stub
  });
}

describe("RestrictedPublisherSigner", () => {
  it("signs a valid append matching the approved payload", async () => {
    const signer = makeSigner();
    const tx = await signer.signAppendReceipt(buildTx(), approved());
    expect(tx.feePayer?.equals(PUBLISHER)).toBe(true);
  });

  it("rejects a mismatched payload hash", async () => {
    const signer = makeSigner();
    await expect(
      signer.signAppendReceipt(buildTx(), { ...approved(), payloadHash: new Uint8Array(32).fill(9) })
    ).rejects.toThrow(/payloadHash/);
  });

  it("rejects a mismatched version", async () => {
    const signer = makeSigner();
    await expect(signer.signAppendReceipt(buildTx(), { ...approved(), version: 4 })).rejects.toThrow(
      /version/
    );
  });

  it("rejects instructions targeting other programs", async () => {
    const signer = makeSigner();
    const tx = buildTx();
    tx.add(
      SystemProgram.transfer({
        fromPubkey: PUBLISHER,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      })
    );
    await expect(signer.signAppendReceipt(tx, approved())).rejects.toThrow(/non-allowlisted/);
  });

  it("rejects non-append receipt-program instructions (publisher role)", async () => {
    const signer = makeSigner();
    const tx = buildTx();
    const [config] = findConfigPda(PROGRAM_ID);
    tx.add(buildPauseIx({ programId: PROGRAM_ID, config, admin: PUBLISHER }));
    await expect(signer.signAppendReceipt(tx, approved())).rejects.toThrow(/only append_receipt/);
  });

  it("rejects transactions requiring a foreign signer", async () => {
    const signer = makeSigner();
    const tx = buildTx();
    const other = Keypair.generate().publicKey;
    tx.instructions[0].keys.push({ pubkey: other, isSigner: true, isWritable: false });
    await expect(signer.signAppendReceipt(tx, approved())).rejects.toThrow(/foreign signer/);
  });

  it("rejects a foreign fee payer", async () => {
    const signer = makeSigner();
    const tx = buildTx();
    tx.feePayer = Keypair.generate().publicKey;
    await expect(signer.signAppendReceipt(tx, approved())).rejects.toThrow(/feePayer/);
  });

  it("bounds priority fees from ComputeBudget instructions", async () => {
    const cheap = makeSigner(100_000);
    const tx = buildTx();
    // 1,000,000 micro-lamports * 200k units / 1e6 = 200,000 lamports > 100,000 bound.
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }));
    await expect(cheap.signAppendReceipt(tx, approved())).rejects.toThrow(/exceeds bound/);

    const rich = makeSigner(1_000_000_000);
    await expect(rich.signAppendReceipt(buildTx(), approved())).resolves.toBeDefined();
  });

  it("allows ComputeBudget limit instructions within the fee bound", async () => {
    const signer = makeSigner(100_000);
    const tx = buildTx();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    await expect(signer.signAppendReceipt(tx, approved())).resolves.toBeDefined();
  });

  it("rejects empty transactions", async () => {
    const signer = makeSigner();
    await expect(signer.signAppendReceipt(new Transaction(), approved())).rejects.toThrow(
      /no instructions/
    );
  });

  it("requires a positive fee bound at construction", () => {
    expect(
      () =>
        new RestrictedPublisherSigner({
          programId: PROGRAM_ID,
          publisher: PUBLISHER,
          maxFeeLamports: 0,
          sign: async (tx) => tx,
        })
    ).toThrow();
  });

  it("rejects unknown ComputeBudget tags", async () => {
    const signer = makeSigner();
    const tx = buildTx();
    const bad = new TransactionInstruction({
      programId: ComputeBudgetProgram.programId,
      keys: [],
      data: Buffer.from([99]),
    });
    tx.add(bad);
    await expect(signer.signAppendReceipt(tx, approved())).rejects.toThrow(/ComputeBudget/);
  });
});
