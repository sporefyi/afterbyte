/**
 * STANDALONE receipt verifier.
 *
 * Dependencies: node built-ins + canonicalize.ts ONLY. No @solana/web3.js, no
 * DB, no API code — this module must stay runnable in isolation (see
 * src/bin/verify.ts).
 *
 * It downloads the canonical bytes from a URL, re-runs the ADR-0002 algorithm,
 * compares the hash with the expected value AND the on-chain receipt account
 * (fetched via plain JSON-RPC), and validates program / subject / version /
 * publisher. Hash verification and source accessibility are reported as
 * separate properties.
 */

import { createHash } from "node:crypto";
import {
  assertSupportedSchemaVersion,
  canonicalize,
  sha256Hex,
} from "./canonicalize.js";

// ---------------------------------------------------------------------------
// Minimal Solana primitives (dependency-free)
// ---------------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(s: string): Uint8Array {
  let num = 0n;
  for (const ch of s) {
    const i = B58_ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

// --- ed25519 curve membership (for PDA derivation) ---

const ED_P = 2n ** 255n - 19n;
// d = -121665 * inv(121666) mod p
function edD(): bigint {
  return ((ED_P - 121665n) * modInv(121666n, ED_P)) % ED_P;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function modInv(a: bigint, m: bigint): bigint {
  return modPow(a, m - 2n, m);
}

/** True iff the 32 bytes are a valid ed25519 curve point (compressed form). */
export function isOnEd25519Curve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const le = Uint8Array.from(bytes);
  le[31] &= 0x7f; // clear sign bit → y
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(le[i]);
  if (y >= ED_P) return false;
  const d = edD();
  const y2 = (y * y) % ED_P;
  const x2 = (((y2 - 1n + ED_P) % ED_P) * modInv((d * y2 + 1n) % ED_P, ED_P)) % ED_P;
  let x = modPow(x2, (ED_P + 3n) / 8n, ED_P);
  if ((x * x - x2) % ED_P !== 0n) {
    x = (x * modPow(2n, (ED_P - 1n) / 4n, ED_P)) % ED_P;
  }
  return (x * x - x2) % ED_P === 0n;
}

const PDA_MARKER = "ProgramDerivedAddress";

/**
 * Solana PDA hash: sha256(seed1 || ... || seedN || bump || programId ||
 * "ProgramDerivedAddress"). Seed/bump order matters — this must match the
 * runtime exactly (cross-checked against @solana/web3.js in tests).
 */
function hashSeeds(seeds: Uint8Array[], programId: Uint8Array, bump: number): Uint8Array {
  const h = createHash("sha256");
  for (const s of seeds) {
    if (s.length > 32) throw new Error("PDA seed longer than 32 bytes");
    h.update(s);
  }
  h.update(Uint8Array.of(bump));
  h.update(programId);
  h.update(PDA_MARKER, "utf8");
  return Uint8Array.from(h.digest());
}

/** Solana PDA derivation (findProgramAddress), dependency-free. */
export function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): { address: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const address = hashSeeds(seeds, programId, bump);
    if (!isOnEd25519Curve(address)) return { address, bump };
  }
  throw new Error("findProgramAddress: no off-curve bump found");
}

// ---------------------------------------------------------------------------
// Account parsing (layout mirrors programs/afterbyte-receipts/src/lib.rs)
// ---------------------------------------------------------------------------

const RECEIPT_SIZE = 164;

function accountDiscriminator(name: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`account:${name}`, "utf8").digest().subarray(0, 8));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ParsedReceipt {
  subjectId: Uint8Array;
  version: bigint;
  payloadHash: Uint8Array;
  previousPayloadHash: Uint8Array;
  publicationKind: number;
  publisher: Uint8Array;
  slot: bigint;
  recordedAt: bigint;
  schemaVersion: number;
  bump: number;
}

export function parseReceiptAccount(data: Uint8Array): ParsedReceipt {
  if (data.length !== RECEIPT_SIZE) {
    throw new Error(`receipt account has unexpected size ${data.length} (expected ${RECEIPT_SIZE})`);
  }
  if (!bytesEqual(data.subarray(0, 8), accountDiscriminator("Receipt"))) {
    throw new Error("receipt account discriminator mismatch");
  }
  const u64le = (o: number) => {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[o + i]);
    return v;
  };
  return {
    subjectId: data.slice(8, 40),
    version: u64le(40),
    payloadHash: data.slice(48, 80),
    previousPayloadHash: data.slice(80, 112),
    publicationKind: data[112],
    publisher: data.slice(113, 145),
    slot: u64le(145),
    recordedAt: u64le(153),
    schemaVersion: data[161] | (data[162] << 8),
    bump: data[163],
  };
}

export interface ParsedSubject {
  subjectId: Uint8Array;
  latestVersion: bigint;
  latestReceiptHash: Uint8Array;
  bump: number;
}

export function parseSubjectAccount(data: Uint8Array): ParsedSubject {
  if (data.length !== 81) throw new Error(`subject account has unexpected size ${data.length}`);
  if (!bytesEqual(data.subarray(0, 8), accountDiscriminator("Subject"))) {
    throw new Error("subject account discriminator mismatch");
  }
  let latestVersion = 0n;
  for (let i = 7; i >= 0; i--) latestVersion = (latestVersion << 8n) | BigInt(data[40 + i]);
  return {
    subjectId: data.slice(8, 40),
    latestVersion,
    latestReceiptHash: data.slice(48, 80),
    bump: data[80],
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC (plain fetch; finalized commitment)
// ---------------------------------------------------------------------------

interface RpcAccount {
  owner: string;
  data: Uint8Array;
}

async function rpcGetAccountInfo(
  rpcUrl: string,
  addressB58: string,
  fetchImpl: typeof fetch
): Promise<RpcAccount | null> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [addressB58, { encoding: "base64", commitment: "finalized" }],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${rpcUrl}`);
  const body = (await res.json()) as {
    result?: { value: null | { owner: string; data: [string, string] } };
    error?: { message: string };
  };
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  const v = body.result?.value;
  if (!v) return null;
  return { owner: v.owner, data: Uint8Array.from(Buffer.from(v.data[0], "base64")) };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: VerifyCheck[];
  canonicalUrl: string;
  receiptAddress: string;
  recomputedHash: string | null;
  onChainHash: string | null;
}

export interface VerifyOptions {
  canonicalUrl: string;
  expectedPayloadHashHex: string;
  rpcUrl: string;
  programId: string; // base58
  subjectIdHex: string; // 64 hex chars
  version: number;
  expectedPublisher?: string; // base58, optional
  fetchImpl?: typeof fetch;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

export async function verifyReceipt(opts: VerifyOptions): Promise<VerifyReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const checks: VerifyCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => {
    checks.push({ name, pass, detail });
  };

  const fail = (e: unknown): VerifyReport => {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      checks,
      canonicalUrl: opts.canonicalUrl,
      receiptAddress: "",
      recomputedHash: null,
      onChainHash: null,
    };
  };

  try {
    if (!HEX64.test(opts.expectedPayloadHashHex)) {
      throw new Error("expectedPayloadHashHex must be 64 hex characters");
    }
    if (!HEX64.test(opts.subjectIdHex)) throw new Error("subjectIdHex must be 64 hex characters");
    if (!Number.isInteger(opts.version) || opts.version < 1) {
      throw new Error("version must be a positive integer");
    }
    const programIdBytes = base58Decode(opts.programId);
    if (programIdBytes.length !== 32) throw new Error("programId must decode to 32 bytes");
    const subjectId = Uint8Array.from(Buffer.from(opts.subjectIdHex, "hex"));

    // Derive the receipt PDA exactly like the program does.
    const versionLe = Buffer.alloc(8);
    versionLe.writeBigUInt64LE(BigInt(opts.version));
    const { address: receiptAddr } = findProgramAddress(
      [
        new TextEncoder().encode("afterbyte-receipt"),
        subjectId,
        Uint8Array.from(versionLe),
      ],
      programIdBytes
    );
    const receiptAddress = base58Encode(receiptAddr);

    // 1. Source accessibility (separate property from hash verification).
    let canonicalBytes: Uint8Array;
    try {
      const res = await fetchImpl(opts.canonicalUrl);
      if (!res.ok) {
        check("canonical_bytes_accessible", false, `HTTP ${res.status} from ${opts.canonicalUrl}`);
        return { ok: false, checks, canonicalUrl: opts.canonicalUrl, receiptAddress, recomputedHash: null, onChainHash: null };
      }
      canonicalBytes = Uint8Array.from(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      check("canonical_bytes_accessible", false, `fetch failed: ${e instanceof Error ? e.message : e}`);
      return { ok: false, checks, canonicalUrl: opts.canonicalUrl, receiptAddress, recomputedHash: null, onChainHash: null };
    }
    check("canonical_bytes_accessible", canonicalBytes.length > 0, `${canonicalBytes.length} bytes`);

    // 2. Re-run the algorithm: parse → canonicalize → must be a fixed point.
    let recomputed: Uint8Array;
    try {
      const parsed = JSON.parse(Buffer.from(canonicalBytes).toString("utf8"));
      assertSupportedSchemaVersion(parsed);
      recomputed = canonicalize(parsed);
    } catch (e) {
      check("canonical_bytes_recanonicalize", false, e instanceof Error ? e.message : String(e));
      return { ok: false, checks, canonicalUrl: opts.canonicalUrl, receiptAddress, recomputedHash: null, onChainHash: null };
    }
    check(
      "canonical_bytes_recanonicalize",
      bytesEqual(recomputed, canonicalBytes),
      "served bytes are the canonical form"
    );

    const recomputedHash = sha256Hex(recomputed);
    check(
      "recomputed_hash_matches_expected",
      recomputedHash.toLowerCase() === opts.expectedPayloadHashHex.toLowerCase(),
      `recomputed ${recomputedHash}`
    );

    // 3. On-chain receipt account (finalized commitment).
    const acct = await rpcGetAccountInfo(opts.rpcUrl, receiptAddress, fetchImpl);
    check("receipt_account_exists", acct !== null, receiptAddress);
    if (!acct) {
      return { ok: false, checks, canonicalUrl: opts.canonicalUrl, receiptAddress, recomputedHash, onChainHash: null };
    }
    check("receipt_account_owned_by_program", acct.owner === opts.programId, `owner ${acct.owner}`);

    let receipt: ParsedReceipt;
    try {
      receipt = parseReceiptAccount(acct.data);
    } catch (e) {
      check("receipt_account_parseable", false, e instanceof Error ? e.message : String(e));
      return { ok: false, checks, canonicalUrl: opts.canonicalUrl, receiptAddress, recomputedHash, onChainHash: null };
    }
    check("receipt_account_parseable", true, `${acct.data.length} bytes`);

    const onChainHash = Buffer.from(receipt.payloadHash).toString("hex");
    check(
      "onchain_payload_hash_matches_expected",
      onChainHash.toLowerCase() === opts.expectedPayloadHashHex.toLowerCase(),
      `on-chain ${onChainHash}`
    );
    check("onchain_version_matches", receipt.version === BigInt(opts.version), `on-chain v${receipt.version}`);
    check("onchain_subject_matches", bytesEqual(receipt.subjectId, subjectId), "subject id matches");
    if (opts.expectedPublisher) {
      const expectedPub = base58Decode(opts.expectedPublisher);
      check(
        "onchain_publisher_matches",
        bytesEqual(receipt.publisher, expectedPub),
        `on-chain ${base58Encode(receipt.publisher)}`
      );
    }

    // 4. Subject cursor consistency.
    const { address: subjectAddr } = findProgramAddress(
      [new TextEncoder().encode("afterbyte-subject"), subjectId],
      programIdBytes
    );
    const subjectAcct = await rpcGetAccountInfo(opts.rpcUrl, base58Encode(subjectAddr), fetchImpl);
    if (subjectAcct) {
      try {
        const subject = parseSubjectAccount(subjectAcct.data);
        check(
          "subject_cursor_consistent",
          subject.latestVersion >= BigInt(opts.version) &&
            (subject.latestVersion > BigInt(opts.version) ||
              bytesEqual(subject.latestReceiptHash, receipt.payloadHash)),
          `latest_version=${subject.latestVersion}`
        );
      } catch (e) {
        check("subject_cursor_consistent", false, e instanceof Error ? e.message : String(e));
      }
    } else {
      check("subject_cursor_consistent", false, "subject account not found");
    }

    const ok = checks.every((c) => c.pass);
    return { ok, checks, canonicalUrl: opts.canonicalUrl, receiptAddress, recomputedHash, onChainHash };
  } catch (e) {
    return fail(e);
  }
}
