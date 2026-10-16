/**
 * Fixed test vectors for the ADR-0002 canonicalization algorithm.
 *
 * All expected hashes were computed with this implementation and independently
 * cross-checked: the XCHECK vector's canonical JSON is byte-identical to
 * Python's `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)`
 * output (same SHA-256). Note: Python's json.dumps differs from RFC 8785 JCS on
 * control characters (it emits short escapes like \n); JCS requires \u00XX —
 * asserted below.
 */
import { describe, expect, it } from "vitest";
import {
  assertSupportedSchemaVersion,
  canonicalize,
  canonicalJson,
  deriveObjectKey,
  deriveSubjectId,
  hashPayload,
  jcsSerialize,
  normalizeTimestamp,
  sha256Hex,
  verifyDigest,
  HASH_SCHEMA_VERSION,
  SUPPORTED_HASH_SCHEMA_VERSIONS,
} from "../src/canonicalize.js";

const BASE_HASH = "656b28dabc006e9508c453ef234b13ff9dc9454ec8db7b5770c0d397f67b805a";
const CHANGED_HASH = "431140b6e4d3bd81ec885d05fd6a20c0b6692aa2c51a78c848f2584180b8cd42";
const SWAPPED_ORDER_HASH = "8242a0f7229af6541f81a9a1b58c6087b7e599d876fb78610b7f60a9c7ec484e";
const UNICODE_HASH = "d01d1fb1f0e7c107d555da3b02788657e1197b4e5c09d4a8301f3fb434b1c67c";
const XCHECK_HASH = "0af981fbd8743adb7165d75508f3603e9d450ced3196001745589a604c7ec6a5";
const SUBJECT_ID_HEX = "58c5d7e9ddc9e5646a896db87b844819d68a0391f398a90d262aa1252b5ada7a"; // sha256("9b2f3c1d-4a5e-6b7c-8d9e-0f1a2b3c4d5e")

function basePayload(): any {
  return {
    schemaVersion: 1,
    subjectId: "9b2f3c1d-4a5e-6b7c-8d9e-0f1a2b3c4d5e",
    versionNumber: 1,
    publicationKind: "initial",
    title: "Café Retro — a forgotten forum",
    summary: "Summary with unicode: naïve façade",
    sections: [
      { display_order: 2, id: "sec-b", body: "Second section" },
      { display_order: 1, id: "sec-a", body: "First section" },
    ],
    lifecycleStatus: "active",
    statusReason: "Still operating",
    evidenceAssessment: { band: "strong", reason: "Multiple snapshots" },
    timeline: [
      { display_order: 2, id: "t2", at: "2026-10-16T14:30:00+05:30", label: "Launch" },
      { display_order: 1, id: "t1", at: "2020-01-01T00:00:00Z", label: "Founding" },
    ],
    claims: [
      { id: "c2", text: "Claim two", citations: [{ source: "s2" }] },
      { id: "c1", text: "Claim one", citations: [{ source: "s1" }] },
    ],
    reviewedAt: "2026-10-16T09:00:00Z",
    intendedPublishedAt: "2026-10-16T09:00:00Z",
    previousPayloadHash: "00".repeat(32),
    sourceSnapshotDigests: ["b".repeat(64), "a".repeat(64)],
    provenance: { researcher: "afterbyte-pipeline", runId: "run-001" },
  };
}

const hashOf = (p: unknown) => sha256Hex(canonicalize(p));

describe("canonicalization vectors (ADR-0002)", () => {
  it("hashes the baseline payload to the fixed vector", () => {
    expect(hashOf(basePayload())).toBe(BASE_HASH);
  });

  it("is invariant under key insertion order", () => {
    const reordered: any = {};
    for (const k of Object.keys(basePayload()).reverse()) reordered[k] = (basePayload() as any)[k];
    expect(hashOf(reordered)).toBe(BASE_HASH);
  });

  it("changes the hash when content changes", () => {
    const changed = { ...basePayload(), summary: "Summary with unicode: naive facade" };
    expect(hashOf(changed)).toBe(CHANGED_HASH);
    expect(CHANGED_HASH).not.toBe(BASE_HASH);
  });

  it("orders sections by display_order then id regardless of input order", () => {
    const p = basePayload();
    // Input already lists display_order 2 before 1 — canonical form sorts them.
    expect(hashOf(p)).toBe(BASE_HASH);
    const canon = canonicalJson(p);
    const secA = canon.indexOf('"id":"sec-a"');
    const secB = canon.indexOf('"id":"sec-b"');
    expect(secA).toBeGreaterThan(-1);
    expect(secB).toBeGreaterThan(secA);
  });

  it("changes the hash when display_order values change", () => {
    const p = basePayload();
    p.sections = [
      { display_order: 1, id: "sec-b", body: "Second section" },
      { display_order: 2, id: "sec-a", body: "First section" },
    ];
    expect(hashOf(p)).toBe(SWAPPED_ORDER_HASH);
  });

  it("sorts claims by id and snapshot digests lexicographically", () => {
    const p = basePayload();
    const canon = canonicalJson(p);
    expect(canon.indexOf('"id":"c1"')).toBeLessThan(canon.indexOf('"id":"c2"'));
    const digestA = `"${"a".repeat(64)}"`;
    const digestB = `"${"b".repeat(64)}"`;
    expect(canon.indexOf(digestA)).toBeGreaterThan(-1);
    expect(canon.indexOf(digestA)).toBeLessThan(canon.indexOf(digestB));
    // Claims already shuffled in input order still hash identically.
    expect(hashOf(p)).toBe(BASE_HASH);
  });

  it("unifies composed and decomposed Unicode via NFC", () => {
    const composed = { ...basePayload(), title: "Café" }; // U+00E9
    const decomposed = { ...basePayload(), title: "Café" }; // e + U+0301
    expect(hashOf(composed)).toBe(UNICODE_HASH);
    expect(hashOf(decomposed)).toBe(UNICODE_HASH);
  });

  it("normalizes equivalent timestamps to the same instant", () => {
    const a = { ...basePayload(), reviewedAt: "2026-10-16T14:30:00+05:30" };
    const b = { ...basePayload(), reviewedAt: "2026-10-16T09:00:00Z" };
    expect(hashOf(a)).toBe(BASE_HASH);
    expect(hashOf(b)).toBe(BASE_HASH);
    expect(normalizeTimestamp("2026-10-16T14:30:00.999+05:30")).toBe("2026-10-16T09:00:00Z");
  });

  it("rejects invalid timestamps (fail closed)", () => {
    expect(() => normalizeTimestamp("2026-06-30T23:59:60Z")).toThrow(); // leap second
    expect(() => normalizeTimestamp("0000-01-01T00:00:00Z")).toThrow(); // year 0000
    expect(() => normalizeTimestamp("2026-02-30T00:00:00Z")).toThrow(); // nonexistent date
    expect(() => normalizeTimestamp("2026-10-16T14:30:00+0530")).toThrow(); // bad offset form
    // Date-only strings are not timestamps: left untouched, not thrown.
    expect(canonicalJson({ d: "2026-10-16" })).toBe('{"d":"2026-10-16"}');
  });

  it("escapes control characters as \\u00XX (JCS, not JSON.stringify short escapes)", () => {
    expect(jcsSerialize({ a: "x\ny" })).toBe('{"a":"x\\u000ay"}');
    expect(jcsSerialize({ a: 'q"\\' })).toBe('{"a":"q\\"\\\\"}');
  });

  it("canonicalizes numbers per RFC 8785 and rejects non-finite", () => {
    expect(jcsSerialize({ n: 1e21 })).toBe('{"n":1e+21}');
    expect(jcsSerialize({ n: -0 })).toBe('{"n":0}');
    expect(() => jcsSerialize({ n: NaN })).toThrow();
    expect(() => jcsSerialize({ n: Infinity })).toThrow();
  });

  it("rejects lone surrogates", () => {
    expect(() => jcsSerialize({ a: "\ud800" })).toThrow();
    expect(() => jcsSerialize({ a: "x\udc00" })).toThrow();
  });

  it("matches the Python reference vector byte-for-byte", () => {
    const xcheck = { z: 1, a: { nested: [3, 2, 1], üñí: "tëxt" }, m: "mixed" };
    expect(canonicalJson(xcheck)).toBe('{"a":{"nested":[3,2,1],"üñí":"tëxt"},"m":"mixed","z":1}');
    expect(hashOf(xcheck)).toBe(XCHECK_HASH);
  });
});

describe("hashing, keys, digests", () => {
  it("exposes the hash schema version", () => {
    expect(HASH_SCHEMA_VERSION).toBe(1);
    expect(SUPPORTED_HASH_SCHEMA_VERSIONS).toContain(1);
  });

  it("hashPayload returns bytes, canonical string and hex consistently", () => {
    const hp = hashPayload(basePayload());
    expect(hp.hex).toBe(BASE_HASH);
    expect(sha256Hex(hp.bytes)).toBe(BASE_HASH);
    expect(hp.canonical).toBe(canonicalJson(basePayload()));
  });

  it("rejects unknown hash schema versions (fail closed)", () => {
    expect(() => assertSupportedSchemaVersion({ schemaVersion: 999 })).toThrow();
    expect(() => hashPayload({ ...basePayload(), schemaVersion: 2 })).toThrow();
    expect(() => assertSupportedSchemaVersion({})).not.toThrow();
  });

  it("derives content-addressed object keys", () => {
    expect(deriveObjectKey(BASE_HASH)).toBe(`receipts/canonical/v1/sha256:${BASE_HASH}.json`);
    expect(() => deriveObjectKey("not-hex")).toThrow();
  });

  it("verifies digests (constant-time)", () => {
    const bytes = canonicalize(basePayload());
    expect(verifyDigest(bytes, BASE_HASH)).toBe(true);
    expect(verifyDigest(bytes, BASE_HASH.toUpperCase())).toBe(true);
    expect(verifyDigest(bytes, CHANGED_HASH)).toBe(false);
    expect(verifyDigest(bytes, "zzz")).toBe(false);
  });

  it("derives the documented subject id digest", () => {
    const { hex, bytes } = deriveSubjectId("9b2f3c1d-4a5e-6b7c-8d9e-0f1a2b3c4d5e");
    expect(hex).toBe(SUBJECT_ID_HEX);
    expect(bytes.length).toBe(32);
    expect(Buffer.from(bytes).toString("hex")).toBe(SUBJECT_ID_HEX);
  });
});
