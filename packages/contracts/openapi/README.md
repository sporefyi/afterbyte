# openapi/

`v1.yaml` is the **checked-in source of truth** for the AFTERBYTE v1 API
contract (Milestone 1 freeze). It is OpenAPI 3.1.

## Authoring

Do NOT hand-edit `v1.yaml`. It is assembled from fragments:

| Fragment | Contents |
|---|---|
| `head.yaml` | `info`, `servers`, `tags`, `securitySchemes`, shared `parameters`, shared `responses` (all 11 error envelopes), and the start of `components/schemas` |
| `schemas-public.yaml` | Public domain schemas (dossier, versions, home, activity, receipts…) |
| `schemas-domain.yaml` | Identity, admin and payment schemas |
| `paths/*.yaml` | One file per endpoint group; each is pasted under `paths:` |

Regenerate with:

```bash
pnpm openapi:assemble   # from packages/contracts
```

CI (and `pnpm test`) fails if the regenerated output differs from the
checked-in `v1.yaml` byte-for-byte.

## Conventions encoded here (brief §12)

- Success envelope `{ data, meta: { requestId, asOf, dataMode, freshness,
  nextCursor, sort?, appliedFilters? } }` — except
  `GET /dossiers/{slug}/versions/{version}/canonical` (exact canonical bytes,
  no envelope) and `GET /events/stream` (`text/event-stream`).
- Error envelope `{ error: { code, message, requestId, retryable,
  fieldErrors } }`; 11 codes in `ErrorCode`.
- Cursor pagination: default 24, max 100, deterministic order with ID
  tiebreaker.
- `ETag`/`If-None-Match` on public reads; `If-Match`/`expectedRevision` on
  editorial updates; `Idempotency-Key` required on payment creation and
  costly mutations.
- `dataMode: "live"` in production. Fixtures are `"demo"` and production
  NEVER serves them.
- Payments are documented as feature-flagged OFF (`PAYMENTS_ENABLED=false`):
  every payment endpoint returns 503 `FEATURE_UNAVAILABLE` until activation.
- No token issuance/ticker/economics content. No real deployment URLs —
  `{API_ORIGIN}` placeholders only.
