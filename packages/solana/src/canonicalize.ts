/**
 * ADR-0002 canonical publication payload + hash scheme.
 *
 * Pipeline: product normalization (NFC, RFC3339 UTC timestamps, deterministic
 * array ordering) → RFC 8785 JCS serialization → SHA-256 over UTF-8 bytes.
 *
 * IMPORTANT: this module does NOT strip private fields. The caller must pass
 * an already public-only payload (no signatures, receipts, view counts, signed
 * URLs, private bodies, secrets, submitter data). Hashing happens over exactly
 * the bytes that are served at the canonical endpoint.
 *
 * Cross-language notes (from design review):
 * - Key/array ordering is UTF-16 *code-unit* order per RFC 8785 (JS string
 *   comparison semantics). Python's sorted() and Rust's str cmp use code
 *   *points* and would disagree on astral characters — non-JS implementations
 *   must encode to UTF-16 first.
 * - NFC (not NFKC): compatibility characters (ligatures, fullwidth forms) are
 *   intentionally NOT unified.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Current normalization/hash scheme version. Bumped if these rules change. */
export const HASH_SCHEMA_VERSION = 1;

/** Normalization versions this implementation can verify. Unknown → reject. */
export const SUPPORTED_HASH_SCHEMA_VERSIONS: readonly number[] = [1];

/** Array keys with documented deterministic ordering (applied at any depth). */
const ORDERED_ARRAY_KEYS: ReadonlySet<string> = new Set([
  "sections",
  "timeline",
  "claims",
  "sourceSnapshotDigests",
]);

/**
 * Strings matching this pattern are treated as timestamps and normalized to
 * RFC3339 UTC seconds (`YYYY-MM-DDTHH:MM:SSZ`). Date-only strings are left
 * untouched. A pattern-matching but invalid timestamp THROWS (fail closed).
 */
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Product normalization
// ---------------------------------------------------------------------------

function compareCodeUnits(a: string, b: string): number {
  // Default JS comparison IS UTF-16 code-unit order (RFC 8785 compliant).
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalize a timestamp-like string to `YYYY-MM-DDTHH:MM:SSZ`; throws if invalid. */
export function normalizeTimestamp(s: string): string {
  const m = TIMESTAMP_RE.exec(s);
  if (!m) throw new Error(`invalid timestamp: ${JSON.stringify(s)}`);
  const Y = Number(m[1]);
  const Mo = Number(m[2]);
  const D = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = Number(m[6]);
  if (Y < 1 || Y > 9999) throw new Error(`timestamp year out of range: ${s}`);
  if (Mo < 1 || Mo > 12) throw new Error(`timestamp month out of range: ${s}`);
  if (h > 23 || mi > 59 || sec > 59) throw new Error(`timestamp time out of range (leap seconds rejected): ${s}`);

  // Validate the calendar date (rejects e.g. 2026-02-30). setUTCFullYear
  // handles years 1-99 correctly (unlike the Date constructor).
  const dt = new Date(0);
  dt.setUTCFullYear(Y, Mo - 1, D);
  dt.setUTCHours(h, mi, sec, 0);
  if (dt.getUTCFullYear() !== Y || dt.getUTCMonth() !== Mo - 1 || dt.getUTCDate() !== D) {
    throw new Error(`nonexistent calendar date: ${s}`);
  }

  let offMin = 0;
  const tz = m[8];
  if (tz !== "Z" && tz !== "z") {
    const sign = tz[0] === "+" ? 1 : -1;
    const oh = Number(tz.slice(1, 3));
    const om = Number(tz.slice(4, 6));
    if (oh > 14 || om > 59) throw new Error(`timestamp offset out of range: ${s}`);
    offMin = sign * (oh * 60 + om);
  }
  const utc = new Date(dt.getTime() - offMin * 60_000);
  return utc.toISOString().slice(0, 19) + "Z"; // truncate fractional seconds
}

function displayOrderOf(item: unknown): number {
  if (item !== null && typeof item === "object") {
    const v = (item as Record<string, unknown>).display_order;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return Number.POSITIVE_INFINITY;
}

function idOf(item: unknown): string {
  if (item !== null && typeof item === "object") {
    const v = (item as Record<string, unknown>).id;
    if (typeof v === "string") return v;
  }
  return "";
}

function compareDisplayOrder(a: number, b: number): number {
  if (a === b) return 0; // handles Infinity === Infinity (avoids NaN)
  return a < b ? -1 : 1;
}

/** Deterministic ordering for arrays under documented keys. */
function orderArray(key: string, arr: unknown[]): unknown[] {
  const items = arr.slice();
  if (key === "sections" || key === "timeline") {
    items.sort((x, y) => {
      const c = compareDisplayOrder(displayOrderOf(x), displayOrderOf(y));
      if (c !== 0) return c;
      const ic = compareCodeUnits(idOf(x), idOf(y));
      if (ic !== 0) return ic;
      // Final tiebreak: the item's own canonical JCS form (total order).
      return compareCodeUnits(jcsSerialize(normalizeValue(x)), jcsSerialize(normalizeValue(y)));
    });
  } else if (key === "claims") {
    items.sort((x, y) => {
      const ic = compareCodeUnits(idOf(x), idOf(y));
      if (ic !== 0) return ic;
      return compareCodeUnits(jcsSerialize(normalizeValue(x)), jcsSerialize(normalizeValue(y)));
    });
  } else if (key === "sourceSnapshotDigests") {
    items.sort((x, y) => compareCodeUnits(String(x), String(y)));
  }
  return items;
}

/** Deep product normalization (NFC, timestamps, array ordering). */
export function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    const nfc = value.normalize("NFC");
    if (TIMESTAMP_RE.test(nfc)) return normalizeTimestamp(nfc);
    return nfc;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      const norm = normalizeValue((value as Record<string, unknown>)[k]);
      out[k] =
        Array.isArray(norm) && ORDERED_ARRAY_KEYS.has(k)
          ? orderArray(k, norm as unknown[])
          : norm;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// RFC 8785 JCS serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a string per RFC 8785 §3.2.2.2: `"` and `\` escaped, control
 * characters as \u00XX. Throws on lone surrogates (ill-formed input).
 * NOTE: unlike JSON.stringify, short escapes (\n, \t) are NOT used.
 */
function jcsString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else {
        throw new Error("JCS: lone high surrogate");
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error("JCS: lone low surrogate");
    } else {
      out += s[i];
    }
  }
  return out + '"';
}

/**
 * Serialize a number per RFC 8785 §3.2.2.1 (ECMAScript canonical form):
 * 1e21 → "1e+21", -0 → "0". Throws on NaN/Infinity — JCS defines no form.
 */
function jcsNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error("JCS: non-finite number has no canonical form");
  if (Object.is(n, -0)) return "0";
  return String(n); // shortest round-trip per ECMAScript
}

/** RFC 8785 JSON Canonicalization Scheme serializer. */
export function jcsSerialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return jcsString(value as string);
  if (t === "number") return jcsNumber(value as number);
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (t === "bigint") throw new Error("JCS: bigint has no canonical form (use strings)");
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : jcsSerialize(v))).join(",") + "]";
  }
  if (t === "object") {
    // Keys sorted by UTF-16 code units (default sort); undefined values dropped
    // (JSON.stringify semantics — documented implementation choice).
    const keys = Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => jcsString(k) + ":" + jcsSerialize((value as Record<string, unknown>)[k])).join(",") +
      "}"
    );
  }
  throw new Error(`JCS: unsupported value type ${t}`);
}

// ---------------------------------------------------------------------------
// Hashing, keys, verification
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** UTF-8 bytes of the canonical JCS document for a payload. */
export function canonicalize(payload: unknown): Uint8Array {
  return new TextEncoder().encode(jcsSerialize(normalizeValue(payload)));
}

/** Canonical JCS document as a string (for storage / debugging). */
export function canonicalJson(payload: unknown): string {
  return jcsSerialize(normalizeValue(payload));
}

/**
 * Throw unless the payload's schema version is supported. `schemaVersion` is
 * the hash-scheme version field (`hashSchemaVersion` accepted as an alias).
 * Unknown versions fail closed — never silently re-canonicalize under new rules.
 */
export function assertSupportedSchemaVersion(payload: unknown): void {
  if (payload !== null && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    const v = rec.schemaVersion ?? rec.hashSchemaVersion;
    if (v !== undefined && !(typeof v === "number" && (SUPPORTED_HASH_SCHEMA_VERSIONS as readonly number[]).includes(v))) {
      throw new Error(`unsupported hash schema version: ${JSON.stringify(v)}`);
    }
  }
}

export interface HashedPayload {
  /** Canonical UTF-8 bytes. */
  bytes: Uint8Array;
  /** Canonical JCS document string. */
  canonical: string;
  /** SHA-256 hex of the canonical bytes. */
  hex: string;
}

/** Canonicalize + hash a publication payload (asserts supported schema version). */
export function hashPayload(payload: unknown): HashedPayload {
  assertSupportedSchemaVersion(payload);
  const canonical = canonicalJson(payload);
  const bytes = new TextEncoder().encode(canonical);
  return { bytes, canonical, hex: sha256Hex(bytes) };
}

/**
 * Content-addressed object key for canonical bytes.
 * Format: `receipts/canonical/v1/sha256:<hex>.json`
 */
export function deriveObjectKey(hex: string): string {
  const h = hex.toLowerCase();
  if (!HEX64_RE.test(h)) throw new Error("deriveObjectKey: expected 64-char hex digest");
  return `receipts/canonical/v1/sha256:${h}.json`;
}

/** Constant-time digest comparison. */
export function verifyDigest(bytes: Uint8Array, expectedHex: string): boolean {
  const h = expectedHex.toLowerCase();
  if (!HEX64_RE.test(h)) return false;
  const actual = Buffer.from(sha256Hex(bytes), "hex");
  const expected = Buffer.from(h, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Documented digest mapping a public subject UUID to the on-chain 32-byte
 * subject id: SHA-256 over the UTF-8 bytes of the UUID string.
 */
export function deriveSubjectId(publicUuid: string): { hex: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(publicUuid);
  const hex = sha256Hex(bytes);
  return { hex, bytes: Uint8Array.from(Buffer.from(hex, "hex")) };
}
