/**
 * Anchor test suite for the afterbyte-receipts program.
 *
 * Run: `anchor test` (requires the pinned toolchain, see ../BUILD.md).
 * Covers: PDA derivation, unauthorized append, out-of-order versions,
 * previous-hash mismatch, idempotent retry, conflicting payload,
 * pause/resume, publisher revoke, and two-step admin rotation.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AfterbyteReceipts } from "../target/types/afterbyte_receipts";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { createHash, randomBytes } from "crypto";

const SEED_CONFIG = Buffer.from("afterbyte-config");
const SEED_PUBLISHER = Buffer.from("afterbyte-publisher");
const SEED_SUBJECT = Buffer.from("afterbyte-subject");
const SEED_RECEIPT = Buffer.from("afterbyte-receipt");

function sha256Hex(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function versionLe(version: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(version));
  return b;
}

/** Mirror of the on-chain PDA derivation (fixed seeds, u64 LE version). */
function derivePdas(programId: PublicKey, subjectId: Buffer, publisher: PublicKey, version: number) {
  const [config] = PublicKey.findProgramAddressSync([SEED_CONFIG], programId);
  const [publisherAuth] = PublicKey.findProgramAddressSync(
    [SEED_PUBLISHER, publisher.toBuffer()],
    programId
  );
  const [subject] = PublicKey.findProgramAddressSync([SEED_SUBJECT, subjectId], programId);
  const [receipt, receiptBump] = PublicKey.findProgramAddressSync(
    [SEED_RECEIPT, subjectId, versionLe(version)],
    programId
  );
  return { config, publisherAuth, subject, receipt, receiptBump };
}

function payloadHashOf(s: string): number[] {
  return Array.from(createHash("sha256").update(s, "utf8").digest());
}

async function expectAnchorError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e: any) {
    const errCode = e?.error?.errorCode?.code;
    assert.strictEqual(
      errCode,
      code,
      `expected Anchor error code ${code}, got ${errCode} (${e?.error?.errorMessage ?? e})`
    );
    return;
  }
  assert.fail(`expected transaction to fail with ${code}, but it succeeded`);
}

describe("afterbyte-receipts", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AfterbyteReceipts as Program<AfterbyteReceipts>;
  const programId = program.programId;

  const admin = Keypair.generate();
  const publisher = Keypair.generate();
  const stranger = Keypair.generate(); // never authorized
  const newAdmin = Keypair.generate();

  const subjectUuid = "9b2f3c1d-4a5e-6b7c-8d9e-0f1a2b3c4d5e";
  const subjectId = sha256Hex(subjectUuid); // documented digest: SHA-256 of UUID string
  const pdas = derivePdas(programId, subjectId, publisher.publicKey, 1);

  const hashV1 = payloadHashOf("canonical-payload-v1");
  const hashV1Alt = payloadHashOf("canonical-payload-v1-tampered");
  const hashV2 = payloadHashOf("canonical-payload-v2");
  const zeroHash = new Array(32).fill(0);

  const appendArgs = (version: number, payloadHash: number[], prevHash: number[]) => ({
    subjectId: Array.from(subjectId),
    version: new anchor.BN(version),
    payloadHash,
    previousPayloadHash: prevHash,
    publicationKind: 0, // initial
    schemaVersion: 1,
  });

  before(async () => {
    // Fund all test keypairs on localnet.
    for (const kp of [admin, publisher, stranger, newAdmin]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "finalized");
    }
    await program.methods
      .initializeConfig(1)
      .accounts({ config: pdas.config, admin: admin.publicKey, systemProgram: SystemProgram.programId })
      .signers([admin])
      .rpc();
    await program.methods
      .authorizePublisher()
      .accounts({
        config: pdas.config,
        publisherAuth: pdas.publisherAuth,
        publisher: publisher.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    await program.methods
      .initializeSubject(Array.from(subjectId))
      .accounts({
        config: pdas.config,
        subject: pdas.subject,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
  });

  it("derives PDAs from the documented fixed seeds", async () => {
    // Re-derive independently and compare; also assert version changes the receipt PDA.
    const again = derivePdas(programId, subjectId, publisher.publicKey, 1);
    assert.ok(again.config.equals(pdas.config));
    assert.ok(again.publisherAuth.equals(pdas.publisherAuth));
    assert.ok(again.subject.equals(pdas.subject));
    assert.ok(again.receipt.equals(pdas.receipt));
    const v2 = derivePdas(programId, subjectId, publisher.publicKey, 2);
    assert.ok(!v2.receipt.equals(pdas.receipt), "version must change the receipt PDA");
    // Integer encoding: seeds use 8-byte little-endian version.
    const [, bumpCheck] = PublicKey.findProgramAddressSync(
      [SEED_RECEIPT, subjectId, versionLe(1)],
      programId
    );
    assert.strictEqual(bumpCheck, pdas.receiptBump);
  });

  it("rejects append from an unauthorized signer", async () => {
    const strangerPdas = derivePdas(programId, subjectId, stranger.publicKey, 1);
    await expectAnchorError(
      program.methods
        .appendReceipt(appendArgs(1, hashV1, zeroHash))
        .accounts({
          config: pdas.config,
          subject: pdas.subject,
          receipt: strangerPdas.receipt,
          publisherAuth: strangerPdas.publisherAuth,
          publisher: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc(),
      "AccountNotInitialized" // no publisher auth PDA exists for the stranger
    );
  });

  it("rejects an out-of-order version (gap)", async () => {
    await expectAnchorError(
      program.methods
        .appendReceipt(appendArgs(2, hashV2, zeroHash))
        .accounts({
          config: pdas.config,
          subject: pdas.subject,
          receipt: derivePdas(programId, subjectId, publisher.publicKey, 2).receipt,
          publisherAuth: pdas.publisherAuth,
          publisher: publisher.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([publisher])
        .rpc(),
      "VersionGap"
    );
  });

  it("rejects a mismatched previous_payload_hash", async () => {
    await expectAnchorError(
      program.methods
        .appendReceipt(appendArgs(1, hashV1, hashV2)) // prev should be zero hash for v1
        .accounts({
          config: pdas.config,
          subject: pdas.subject,
          receipt: pdas.receipt,
          publisherAuth: pdas.publisherAuth,
          publisher: publisher.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([publisher])
        .rpc(),
      "PreviousHashMismatch"
    );
  });

  it("appends version 1 and advances the subject cursor", async () => {
    await program.methods
      .appendReceipt(appendArgs(1, hashV1, zeroHash))
      .accounts({
        config: pdas.config,
        subject: pdas.subject,
        receipt: pdas.receipt,
        publisherAuth: pdas.publisherAuth,
        publisher: publisher.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([publisher])
      .rpc();

    const receipt = await program.account.receipt.fetch(pdas.receipt);
    assert.deepStrictEqual(Array.from(receipt.payloadHash), hashV1);
    assert.ok(receipt.publisher.equals(publisher.publicKey));
    assert.strictEqual(receipt.version.toNumber(), 1);
    assert.deepStrictEqual(Object.keys(receipt.publicationKind)[0], "initial");

    const subject = await program.account.subject.fetch(pdas.subject);
    assert.strictEqual(subject.latestVersion.toNumber(), 1);
    assert.deepStrictEqual(Array.from(subject.latestReceiptHash), hashV1);
  });

  it("treats a duplicate append with the same payload as success (idempotent)", async () => {
    const subjectBefore = await program.account.subject.fetch(pdas.subject);
    await program.methods
      .appendReceipt(appendArgs(1, hashV1, zeroHash))
      .accounts({
        config: pdas.config,
        subject: pdas.subject,
        receipt: pdas.receipt,
        publisherAuth: pdas.publisherAuth,
        publisher: publisher.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([publisher])
      .rpc(); // must NOT throw
    const subjectAfter = await program.account.subject.fetch(pdas.subject);
    assert.strictEqual(subjectAfter.latestVersion.toNumber(), subjectBefore.latestVersion.toNumber());
    assert.deepStrictEqual(
      Array.from(subjectAfter.latestReceiptHash),
      Array.from(subjectBefore.latestReceiptHash)
    );
  });

  it("rejects a different payload for the same version (conflict)", async () => {
    await expectAnchorError(
      program.methods
        .appendReceipt(appendArgs(1, hashV1Alt, zeroHash))
        .accounts({
          config: pdas.config,
          subject: pdas.subject,
          receipt: pdas.receipt,
          publisherAuth: pdas.publisherAuth,
          publisher: publisher.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([publisher])
        .rpc(),
      "ConflictingReceipt"
    );
  });

  it("blocks appends while paused and resumes afterwards", async () => {
    await program.methods
      .pause()
      .accounts({ config: pdas.config, admin: admin.publicKey })
      .signers([admin])
      .rpc();

    const v2pda = derivePdas(programId, subjectId, publisher.publicKey, 2).receipt;
    await expectAnchorError(
      program.methods
        .appendReceipt(appendArgs(2, hashV2, hashV1))
        .accounts({
          config: pdas.config,
          subject: pdas.subject,
          receipt: v2pda,
          publisherAuth: pdas.publisherAuth,
          publisher: publisher.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([publisher])
        .rpc(),
      "Paused"
    );

    await program.methods
      .resume()
      .accounts({ config: pdas.config, admin: admin.publicKey })
      .signers([admin])
      .rpc();

    // v2 append now succeeds, chaining to v1's hash.
    await program.methods
      .appendReceipt(appendArgs(2, hashV2, hashV1))
      .accounts({
        config: pdas.config,
        subject: pdas.subject,
        receipt: v2pda,
        publisherAuth: pdas.publisherAuth,
        publisher: publisher.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([publisher])
      .rpc();
    const subject = await program.account.subject.fetch(pdas.subject);
    assert.strictEqual(subject.latestVersion.toNumber(), 2);
  });

  it("blocks appends after the publisher is revoked", async () => {
    const subjectUuid2 = "11111111-2222-3333-4444-555555555555";
    const subjectId2 = sha256Hex(subjectUuid2);
    const p2 = derivePdas(programId, subjectId2, publisher.publicKey, 1);
    await program.methods
      .initializeSubject(Array.from(subjectId2))
      .accounts({
        config: pdas.config,
        subject: p2.subject,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    await program.methods
      .revokePublisher()
      .accounts({
        config: pdas.config,
        publisherAuth: pdas.publisherAuth,
        publisher: publisher.publicKey,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    await expectAnchorError(
      program.methods
        .appendReceipt(appendArgs(1, hashV1, zeroHash))
        .accounts({
          config: pdas.config,
          subject: p2.subject,
          receipt: p2.receipt,
          publisherAuth: pdas.publisherAuth,
          publisher: publisher.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([publisher])
        .rpc(),
      "PublisherInactive"
    );
    // Re-authorize for subsequent tests.
    await program.methods
      .authorizePublisher()
      .accounts({
        config: pdas.config,
        publisherAuth: pdas.publisherAuth,
        publisher: publisher.publicKey,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
  });

  it("requires explicit acceptance for admin rotation", async () => {
    // Start rotation to newAdmin.
    await program.methods
      .rotateAdmin(newAdmin.publicKey)
      .accounts({ config: pdas.config, admin: admin.publicKey })
      .signers([admin])
      .rpc();

    let config = await program.account.config.fetch(pdas.config);
    assert.ok(config.administrator.equals(admin.publicKey), "admin must not change before acceptance");
    assert.ok(config.pendingAdministrator.equals(newAdmin.publicKey));

    // Wrong key cannot accept.
    await expectAnchorError(
      program.methods
        .acceptAdmin()
        .accounts({ config: pdas.config, newAdmin: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "NotPendingAdmin"
    );

    // Pending key accepts; rotation completes.
    await program.methods
      .acceptAdmin()
      .accounts({ config: pdas.config, newAdmin: newAdmin.publicKey })
      .signers([newAdmin])
      .rpc();
    config = await program.account.config.fetch(pdas.config);
    assert.ok(config.administrator.equals(newAdmin.publicKey));
    assert.ok(config.pendingAdministrator === null);

    // Old admin can no longer pause.
    await expectAnchorError(
      program.methods
        .pause()
        .accounts({ config: pdas.config, admin: admin.publicKey })
        .signers([admin])
        .rpc(),
      "UnauthorizedPublisher"
    );

    // Rotate back so later runs start clean (newAdmin is now admin).
    await program.methods
      .rotateAdmin(admin.publicKey)
      .accounts({ config: pdas.config, admin: newAdmin.publicKey })
      .signers([newAdmin])
      .rpc();
    await program.methods
      .acceptAdmin()
      .accounts({ config: pdas.config, newAdmin: admin.publicKey })
      .signers([admin])
      .rpc();
    config = await program.account.config.fetch(pdas.config);
    assert.ok(config.administrator.equals(admin.publicKey));
  });

  it("rejects an unknown publication kind discriminant", async () => {
    const subjectUuid3 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const subjectId3 = sha256Hex(subjectUuid3);
    const p3 = derivePdas(programId, subjectId3, publisher.publicKey, 1);
    await program.methods
      .initializeSubject(Array.from(subjectId3))
      .accounts({
        config: pdas.config,
        subject: p3.subject,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();
    const badArgs = appendArgs(1, hashV1, zeroHash);
    (badArgs as any).publicationKind = 9; // reserved discriminant
    await expectAnchorError(
      program.methods
        .appendReceipt(badArgs)
        .accounts({
          config: pdas.config,
          subject: p3.subject,
          receipt: p3.receipt,
          publisherAuth: pdas.publisherAuth,
          publisher: publisher.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([publisher])
        .rpc(),
      "InvalidPublicationKind"
    );
  });
});
