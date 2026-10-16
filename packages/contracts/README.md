# @afterbyte/contracts

The FROZEN v1 frontend contract (Milestone 1 deliverable).

- `openapi/v1.yaml` — OpenAPI 3.1, checked in, source of truth. 70 paths,
  77 operations across `public`, `identity`, `admin` and `payments` tags.
- `src/types.ts` — TypeScript types generated from the YAML by the pinned
  `openapi-typescript` (deterministic, checked in; CI verifies sync).
- `src/client.ts` — typed fetch-based `AfterbyteClient` (no database
  imports). Covers all 77 operations + the SSE stream helper.
- `fixtures/` — clearly-labelled `"dataMode": "demo"` fixtures; production
  NEVER serves them.
- `tests/` — contract tests: YAML parses, all `$ref`s resolve, fixtures
  validate against schemas (ajv), assembler output and generated types are
  byte-identical to the checked-in files.

```bash
pnpm install        # from the repo root (workspace)
pnpm --filter @afterbyte/contracts build      # assemble + gen:types + tsc
pnpm --filter @afterbyte/contracts typecheck
pnpm --filter @afterbyte/contracts test
pnpm --filter @afterbyte/contracts lint       # structural OpenAPI lint
```
