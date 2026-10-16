# Fixtures

**DEMO ONLY.** Every file in this directory is a synthetic, clearly-labelled
fixture for contract tests and local development. Each fixture carries
`"dataMode": "demo"` in its envelope meta.

**Production NEVER serves fixtures.** Production reads are always
`"dataMode": "live"`. If a dependency fails, production returns a real error
(brief §12 error envelope) — never invented data.

| File | Validates against | Notes |
|---|---|---|
| `dossier.json` | `DossierDetail` + `ResponseMeta` | Mirrors brief §13 shape exactly (example-project, v3). |
| `error-envelope.json` | `ErrorEnvelope` | One sample per brief error code (all 11). |
| `activity-event.json` | `ActivityEvent` | `dossier.published`, `receipt.finalized`, `resync_required`; `sequenceId` values are strings. |

The contract test suite (`pnpm test`) dereferences `openapi/v1.yaml` and
validates every fixture against its schema with ajv.
