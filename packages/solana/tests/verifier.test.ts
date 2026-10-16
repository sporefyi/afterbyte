/**
 * Tests for the standalone verifier: base58, ed25519 PDA derivation
 * (cross-checked against @solana/web3.js), account parsing, and the full
 * verifyReceipt flow with a mocked fetch/RPC.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  base58Decode,
  base58Encode,
  findProgramAddress,
  isOnEd25519Curve,
  parseReceiptAccount,
  parseSubjectAccount,
  verifyReceipt,
} from "../src/verifier.js";
import { canonicalize, sha256Hex } from "../src/canonicalize.js";

const te = (s: string) => new TextEncoder().encode(s);

describe("base58", () => {
  it("encodes a known vector", () => {
    expect(base58Encode(te("Hello World"))).toBe("JxF12TrwUP45BMd");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 250, 255, 0, 17]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it("rejects invalid characters", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});

describe("ed25519 PDA derivation", () => {
  it("agrees with @solana/web3.js findProgramAddressSync", () => {
    const cases: Array<{ seeds: Uint8Array[]; programId: Uint8Array }> = [];
    const programs = [
      Keypair.generate().publicKey.toBytes(),
      new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLn").toBytes(),
    ];
    const seedSets = [
      [te("afterbyte-receipt"), new Uint8Array(32).fill(1), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(7n); return new Uint8Array(b); })()],
      [te("afterbyte-config")],
      [te("x"), te("y"), te("z")],
    ];
    for (const programId of programs) {
      for (const seeds of seedSets) {
        const mine = findProgramAddress(seeds, programId);
        const [theirs, bump] = PublicKey.findProgramAddressSync(
          seeds.map((s) => Buffer.from(s)),
          new PublicKey(programId)
        );
        expect(base58Encode(mine.address)).toBe(theirs.toBase58());
        expect(mine.bump).toBe(bump);
        cases.push({ seeds, programId });
      }
    }
    expect(cases.length).toBe(6);
  });

  it("classifies on-curve and off-curve points like @solana/web3.js", () => {
    // A real ed25519 pubkey is on-curve.
    const pubkey = Keypair.generate().publicKey.toBytes();
    expect(isOnEd25519Curve(pubkey)).toBe(true);
    expect(isOnEd25519Curve(pubkey)).toBe(PublicKey.isOnCurve(pubkey));
    // 32 zero bytes: y=0 IS a valid compressed point (-1 is a quadratic
    // residue mod 2^255-19), so both implementations agree it is on-curve.
    const zeros = new Uint8Array(32);
    expect(isOnEd25519Curve(zeros)).toBe(PublicKey.isOnCurve(zeros));
    // A random sample must agree with the reference implementation.
    for (let i = 0; i < 20; i++) {
      const r = Uint8Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
      expect(isOnEd25519Curve(r)).toBe(PublicKey.isOnCurve(r));
    }
  });
});

describe("account parsing", () => {
  const RECEIPT_DISC = createHash("sha256").update("account:Receipt", "utf8").digest().subarray(0, 8);
  const SUBJECT_DISC = createHash("sha256").update("account:Subject", "utf8").digest().subarray(0, 8);

  function receiptBytes(fields: {
    subjectId: Uint8Array;
    version: bigint;
    payloadHash: Uint8Array;
    publisher: Uint8Array;
  }): Uint8Array {
    const b = Buffer.alloc(164);
    RECEIPT_DISC.copy(b, 0);
    Buffer.from(fields.subjectId).copy(b, 8);
    b.writeBigUInt64LE(fields.version, 40);
    Buffer.from(fields.payloadHash).copy(b, 48);
    Buffer.alloc(32, 0).copy(b, 80); // previous hash
    b.writeUInt8(2, 112); // correction
    Buffer.from(fields.publisher).copy(b, 113);
    b.writeBigUInt64LE(123456789n, 145); // slot
    b.writeBigUInt64LE(1729000000n, 153); // recorded_at
    b.writeUInt16LE(1, 161);
    b.writeUInt8(255, 163);
    return new Uint8Array(b);
  }

  const subjectId = new Uint8Array(32).fill(11);
  const payloadHash = new Uint8Array(32).fill(22);
  const publisher = Keypair.generate().publicKey.toBytes();

  it("parses a receipt account at the documented offsets", () => {
    const parsed = parseReceiptAccount(receiptBytes({ subjectId, version: 3n, payloadHash, publisher }));
    expect(parsed.version).toBe(3n);
    expect(Buffer.from(parsed.subjectId).toString("hex")).toBe(Buffer.from(subjectId).toString("hex"));
    expect(Buffer.from(parsed.payloadHash).toString("hex")).toBe(Buffer.from(payloadHash).toString("hex"));
    expect(parsed.publicationKind).toBe(2);
    expect(parsed.slot).toBe(123456789n);
    expect(parsed.schemaVersion).toBe(1);
    expect(base58Encode(parsed.publisher)).toBe(new PublicKey(publisher).toBase58());
  });

  it("rejects bad discriminator and size", () => {
    const good = receiptBytes({ subjectId, version: 1n, payloadHash, publisher });
    const badDisc = Uint8Array.from(good);
    badDisc[0] ^= 0xff;
    expect(() => parseReceiptAccount(badDisc)).toThrow(/discriminator/);
    expect(() => parseReceiptAccount(good.slice(0, 100))).toThrow(/size/);
  });

  it("parses a subject account", () => {
    const b = Buffer.alloc(81);
    SUBJECT_DISC.copy(b, 0);
    Buffer.from(subjectId).copy(b, 8);
    b.writeBigUInt64LE(3n, 40);
    Buffer.from(payloadHash).copy(b, 48);
    const parsed = parseSubjectAccount(new Uint8Array(b));
    expect(parsed.latestVersion).toBe(3n);
    expect(Buffer.from(parsed.latestReceiptHash).toString("hex")).toBe(
      Buffer.from(payloadHash).toString("hex")
    );
  });
});

describe("verifyReceipt (mocked network)", () => {
  const PROGRAM_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLn";
  const RPC_URL = "https://rpc.example.invalid";
  const CANONICAL_URL = "https://cdn.example.invalid/receipts/canonical/v1/sha256:abc.json";
  const SUBJECT_HEX = "58c5d7e9ddc9e5646a896db87b844819d68a0391f398a90d262aa1252b5ada7a";
  const PUBLISHER = Keypair.generate().publicKey;
  const VERSION = 3;

  const payload = { schemaVersion: 1, title: "Mock dossier", versionNumber: VERSION };
  const canonicalBytes = canonicalize(payload);
  const EXPECTED_HASH = sha256Hex(canonicalBytes);

  function accountEnvelope(data: Uint8Array): object {
    return {
      jsonrpc: "2.0",
      id: 1,
      result: {
        value: {
          owner: PROGRAM_ID,
          data: [Buffer.from(data).toString("base64"), "base64"],
        },
      },
    };
  }

  function receiptAccount(payloadHashHex: string): Uint8Array {
    const disc = createHash("sha256").update("account:Receipt", "utf8").digest().subarray(0, 8);
    const b = Buffer.alloc(164);
    disc.copy(b, 0);
    Buffer.from(SUBJECT_HEX, "hex").copy(b, 8);
    b.writeBigUInt64LE(BigInt(VERSION), 40);
    Buffer.from(payloadHashHex, "hex").copy(b, 48);
    Buffer.alloc(32, 0).copy(b, 80);
    b.writeUInt8(0, 112);
    PUBLISHER.toBuffer().copy(b, 113);
    b.writeBigUInt64LE(999n, 145);
    b.writeBigUInt64LE(1729000000n, 153);
    b.writeUInt16LE(1, 161);
    b.writeUInt8(254, 163);
    return new Uint8Array(b);
  }

  function subjectAccount(latestVersion: bigint, latestHashHex: string): Uint8Array {
    const disc = createHash("sha256").update("account:Subject", "utf8").digest().subarray(0, 8);
    const b = Buffer.alloc(81);
    disc.copy(b, 0);
    Buffer.from(SUBJECT_HEX, "hex").copy(b, 8);
    b.writeBigUInt64LE(latestVersion, 40);
    Buffer.from(latestHashHex, "hex").copy(b, 48);
    return new Uint8Array(b);
  }

  function mockFetch(overrides?: {
    canonicalStatus?: number;
    receiptData?: Uint8Array | null;
    subjectData?: Uint8Array | null;
  }): typeof fetch {
    const receiptAddr = (() => {
      const { address } = findProgramAddress(
        [te("afterbyte-receipt"), Uint8Array.from(Buffer.from(SUBJECT_HEX, "hex")), (() => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(VERSION)); return new Uint8Array(x); })()],
        base58Decode(PROGRAM_ID)
      );
      return base58Encode(address);
    })();
    const subjectAddr = (() => {
      const { address } = findProgramAddress(
        [te("afterbyte-subject"), Uint8Array.from(Buffer.from(SUBJECT_HEX, "hex"))],
        base58Decode(PROGRAM_ID)
      );
      return base58Encode(address);
    })();
    return (async (url: any, init?: any): Promise<Response> => {
      const u = String(url);
      if (u === CANONICAL_URL) {
        if ((overrides?.canonicalStatus ?? 200) !== 200) return new Response("not found", { status: 404 });
        return new Response(Buffer.from(canonicalBytes) as any);
      }
      if (u === RPC_URL) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const addr = body?.params?.[0];
        let data: Uint8Array | null = null;
        if (addr === receiptAddr) data = overrides?.receiptData ?? receiptAccount(EXPECTED_HASH);
        if (addr === subjectAddr) data = overrides?.subjectData ?? subjectAccount(BigInt(VERSION), EXPECTED_HASH);
        if (overrides && "receiptData" in overrides && addr === receiptAddr) data = overrides.receiptData!;
        if (overrides && "subjectData" in overrides && addr === subjectAddr) data = overrides.subjectData!;
        if (!data) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: null } }));
        return new Response(JSON.stringify(accountEnvelope(data)));
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
  }

  const baseOpts = {
    canonicalUrl: CANONICAL_URL,
    expectedPayloadHashHex: EXPECTED_HASH,
    rpcUrl: RPC_URL,
    programId: PROGRAM_ID,
    subjectIdHex: SUBJECT_HEX,
    version: VERSION,
    expectedPublisher: PUBLISHER.toBase58(),
  };

  it("verifies a consistent receipt end-to-end", async () => {
    const report = await verifyReceipt({ ...baseOpts, fetchImpl: mockFetch() });
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.checks.every((c) => c.pass)).toBe(true);
    expect(report.recomputedHash).toBe(EXPECTED_HASH);
    expect(report.onChainHash).toBe(EXPECTED_HASH);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("canonical_bytes_accessible");
    expect(names).toContain("recomputed_hash_matches_expected");
    expect(names).toContain("onchain_payload_hash_matches_expected");
    expect(names).toContain("onchain_publisher_matches");
  });

  it("fails when the on-chain hash differs (hash vs source reported separately)", async () => {
    const other = "ab".repeat(32);
    const report = await verifyReceipt({
      ...baseOpts,
      fetchImpl: mockFetch({ receiptData: receiptAccount(other) }),
    });
    expect(report.ok).toBe(false);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    // Source is accessible and the canonical bytes hash to the expected value…
    expect(byName["canonical_bytes_accessible"].pass).toBe(true);
    expect(byName["recomputed_hash_matches_expected"].pass).toBe(true);
    // …but the chain disagrees.
    expect(byName["onchain_payload_hash_matches_expected"].pass).toBe(false);
  });

  it("fails when the canonical source is unreachable", async () => {
    const report = await verifyReceipt({
      ...baseOpts,
      fetchImpl: mockFetch({ canonicalStatus: 404 }),
    });
    expect(report.ok).toBe(false);
    const accessible = report.checks.find((c) => c.name === "canonical_bytes_accessible");
    expect(accessible?.pass).toBe(false);
  });

  it("fails when the receipt account does not exist", async () => {
    const report = await verifyReceipt({
      ...baseOpts,
      fetchImpl: mockFetch({ receiptData: null }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "receipt_account_exists")?.pass).toBe(false);
  });

  it("fails on publisher mismatch", async () => {
    const report = await verifyReceipt({
      ...baseOpts,
      expectedPublisher: Keypair.generate().publicKey.toBase58(),
      fetchImpl: mockFetch(),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "onchain_publisher_matches")?.pass).toBe(false);
  });

  it("rejects malformed inputs without network calls", async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls++;
      throw new Error("must not be called");
    }) as typeof fetch;
    const report = await verifyReceipt({ ...baseOpts, expectedPayloadHashHex: "zzz", fetchImpl: counting });
    expect(report.ok).toBe(false);
    expect(calls).toBe(0);
  });
});
