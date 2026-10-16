# AFTERBYTE — frontend integration guide

Version: 0.2 (endpoint details verified against the built OpenAPI contract —
apps/api/test/conformance.test.ts asserts every contract operation has a
registered route and vice versa; contract is 72 paths / 80 operations).
Base URL: `{API_ORIGIN}/api/v1`. Same-origin routing under `/api/v1` is preferred;
if the frontend is on a different origin, cookies use the explicit CORS/cookie
strategy documented in `/config` — never assume third-party cookies work.

## Auth

Reading is anonymous. Personal actions need wallet sign-in:

1. `POST /auth/challenge` → server returns a challenge (domain, URI, address,
   nonce, issued/expiry ~5 min, request ID). Stored server-side, single-use.
2. Sign the challenge message with the wallet (Solana Wallet Standard sign-in /
   message flow). This is a login signature, not a payment transaction.
3. `POST /auth/verify` → sets a secure HttpOnly session cookie. CSRF protection
   applies to mutations — send the CSRF token the API issues.
4. `POST /auth/logout` invalidates the session. Sessions have idle + absolute expiry.

Sessions: cookie-based, same-origin by default. SSE (`/events/stream`) follows the
same policy (cookies sent with `EventSource({withCredentials: true})`).

## Envelopes

Success:
```json
{ "data": { ... }, "meta": { "requestId": "uuid", "asOf": "2026-10-16T08:00:00Z",
  "dataMode": "live", "freshness": "fresh", "nextCursor": null } }
```
- `dataMode`: `live` | `demo` (demo only in dev fixtures, explicitly labelled).
- `freshness`: `fresh` | `stale` | `unknown`.
- `nextCursor`: opaque cursor for the next page, or null.

Error:
```json
{ "error": { "code": "NOT_FOUND", "message": "...", "requestId": "uuid",
  "retryable": false, "fieldErrors": [] } }
```
Codes: `VALIDATION_FAILED` (422), `UNAUTHORIZED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `VERSION_CONFLICT` (409), `RATE_LIMITED` (429),
`FEATURE_UNAVAILABLE` (503), `PROVIDER_UNAVAILABLE` (503),
`PAYMENT_NOT_FINALIZED` (409), `PAYMENT_MISMATCH` (422), `PROOF_PENDING` (503).
`Retry-After` is set where useful.

## Key endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | brand metadata, canonical URLs, feature flags, chain, program/mint addresses **only if configured**, provider status, accepted payment assets. Drive all conditional UI from this. |
| GET | `/home` | one consistent read model: edition, headlines, featured dossiers, recent changes, Still Alive picks, research feed preview, stats. |
| GET | `/dossiers?q&category&lifecycleStatus&era&sort&cursor&limit` | sort: `relevance`, `recently_updated`, `recently_verified`. Default limit 24, max 100. |
| GET | `/dossiers/:slug` | current published detail + review/freshness/proof summaries. |
| GET | `/dossiers/:slug/versions` | version summaries incl. correction/retraction labels. |
| GET | `/dossiers/:slug/versions/:version` | immutable version content + current receipt metadata (computed separately). |
| GET | `/dossiers/:slug/versions/:version/canonical` | exact canonical bytes — **no envelope**; hash verification uses these bytes only. |
| GET | `/dossiers/:slug/timeline` | events with date precision (`year`/`month`/`day`) — never invent precision. |
| GET | `/dossiers/:slug/sources` | public metadata + approved excerpts only. |
| GET | `/dossiers/:slug/metrics` | real observations with units/provenance; gaps stay gaps. |
| GET | `/dossiers/:slug/relations` | bounded relationship graph with supporting claim IDs. |
| GET | `/dossiers/:slug/changes` | diffs across versions. |
| GET | `/collections/:slug` | editorial collections (`still-alive`, `revivals`, …). |
| GET | `/search/suggest?q` | title/alias matches only, cached. |
| GET | `/activity?after=` | public events after a sequence ID (string). |
| GET | `/events/stream` | SSE (see below). |
| GET | `/stats` | counters with `asOf`, definitions, freshness. |
| GET | `/receipts/:id` | chain metadata, finality, hash, canonical bundle link. |
| GET | `/methodology`, `/status` | published methodology + safe operational status. |
| GET | `/share/dossiers/:slug/:version` | immutable share card metadata. |

Personal (auth required): `/me`, `/me/bookmarks[/:subjectId]`, `/me/watchlist[/:subjectId]`,
`/me/notifications[/:id]` (read-state only), `POST /submissions`, `POST /dossiers/:slug/corrections`,
`/me/submissions`, `/me/orders`.

Payments (Release B, currently disabled): all return `FEATURE_UNAVAILABLE` until
`/config` shows payments enabled. **Never render a payment CTA while disabled.**

## Pagination, caching, concurrency

- Cursor pagination with deterministic ordering (ID tiebreaker); `nextCursor` in `meta`.
- Public reads: `ETag`/`If-None-Match` supported; home/list cached 30–60s server-side.
- Version-specific canonical bytes: long immutable cache. Current dossier URLs:
  mutable — invalidate on SSE events.
- Editorial updates use `If-Match` / expected revision → `VERSION_CONFLICT` on stale edits.

## SSE contract (`GET /events/stream`)

Event types: `dossier.published`, `dossier.corrected`, `dossier.retracted`,
`subject.status_changed`, `research.started`, `research.completed`, `receipt.finalized`.

Each event: `eventId`, `sequenceId` (BIGINT as string), `eventType`, `occurredAt`,
`subjectId`, `dossierVersion`, `aggregateRevision`, small public payload.
Heartbeat every 20s; reconnect with `Last-Event-ID`. Events older than the 7-day
retention yield `resync_required` → reload canonical state. Delivery is at-least-once:
dedupe by `eventId`, ignore older `aggregateRevision`. If SSE is unavailable, poll
with exponential backoff and show a visible "last updated" timestamp.

## Proof panel states

Distinguish three independent states (never conflate):
- **Content published** — version committed in the database (the authority).
- **Transaction submitted** — signature exists, not yet finalized.
- **Receipt finalized** — on-chain, finalized. Only this earns the "Recorded on Solana"
  badge. Anything earlier shows "receipt pending".

`/receipts/:id` gives signature, slot, block time, program, and the canonical bundle
link for independent verification.

## Required UI states

Implement all of: loading, empty, error, stale, partially available,
authentication required, receipt pending, payment pending, feature unavailable.
A missing backend capability must never leave a decorative CTA that pretends to
succeed — hide or disable it based on `/config` flags. Dev fixtures carry an explicit
demo label; production never serves fixtures.

## Media

Assets expose: id, public URL, dimensions, aspect ratio, alt text, attribution,
rights status. Request hero/media lazily; provide small variants. Respect reduced
motion, keyboard access, and mobile performance. Essential content must read fine
without WebGL.
