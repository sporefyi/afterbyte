# ADR-0002 — Canonical publication payload and hash scheme

Status: accepted · 2026-10-16 · `hashSchemaVersion: 1`

## Decision

Publication payload (public only — no signatures, receipts, view counts, signed URLs,
private bodies, secrets, submitter data):

```
schemaVersion, subjectId, versionNumber, publicationKind,
title, summary, sections[],            # ordered
lifecycleStatus, statusReason,
evidenceAssessment {band, reason},
timeline[] ordered, claims[] with citation metadata,
reviewedAt, intendedPublishedAt, previousPayloadHash,
sourceSnapshotDigests[], provenance fields
```

Normalization (product rules, applied BEFORE JCS — JCS alone does not do these):

1. Unicode: NFC normalization on all string values.
2. Timestamps: RFC 3339 `YYYY-MM-DDTHH:MM:SSZ` (UTC, seconds precision).
3. Arrays: deterministic order — sections/timeline by `display_order` then `id`;
   claims by `id`; snapshot digests lexicographic.
4. Numbers: large integers and monetary values as strings; never floats for money.
5. Object keys: handled by RFC 8785 JCS (after the above normalization).
6. Hash: SHA-256 over UTF-8 bytes of the canonical JCS document.

`previousPayloadHash` chains versions (hash of vN-1's canonical bytes); v1 uses the
32-byte zero string. The intended publication timestamp is fixed before hashing; the
chain timestamp is recorded separately in `publication_receipts`.

## Consequences

- Canonical bytes stored at a content-addressed key; digest verified after write.
- DB commit of the immutable version + current-version pointer + receipt outbox job
  is one transaction — the DB commit is the publication authority.
- Standalone verifier downloads canonical bytes, re-runs this algorithm, compares the
  on-chain hash, and validates program/subject/version/publisher.
- Any change to these rules bumps `hashSchemaVersion`; old versions stay verifiable.
