# AFTERBYTE backend

“The internet moves on. We follow up.”

Standalone editorial research product: a searchable archive of dossiers about forgotten apps,
websites, games, memes, online communities and crypto projects. Each published dossier is
evidence-linked, editorially reviewed, immutably versioned, and anchored on Solana via a
small receipt program (hash commitment only — no custody, no token).

**Release A scope**: archive, dossiers, evidence, timelines, editorial review, corrections,
search, public activity, optional wallet accounts, mainnet publication receipts after
validation. Payments (Release B) and token utility (Release C) are **interfaces behind
feature flags only** — no payment CTA before the settlement path is verified, no token
issuance, no tokenomics in this repo.

> Nothing here is claimed to be deployed. Receipts/addresses in docs are real only when a
> deployment manifest exists. `payments.enabled=false` and `token.enabled=false` defaults.

## Module map

```
apps/api            Fastify API + versioned REST + OpenAPI + public SSE
apps/worker         BullMQ consumers: ingestion, extraction, drafting, monitoring,
                    publication, receipt anchoring/reconciliation, read-model refresh
packages/contracts  Checked-in OpenAPI v1 (source of truth) + generated TS client + fixtures
packages/database   Drizzle schema + migrations + seed + db client
packages/research   Provider adapters (discover/fetch/normalize/health), research
                    pipeline, prompt templates, cost controls, extraction schemas
packages/storage    S3-compatible public/private buckets, versioned bundles, quarantine
packages/solana     Receipt program client (pinned SDK), publisher signing boundary,
                    transaction persistence + retry/reconcile, standalone verifier
packages/observability  Structured logs, OTel traces/metrics, health probes
programs/afterbyte-receipts  Anchor program: config/publisher/subject/receipt PDAs,
                    append-only version hashes. No custody. No token.
docs/               ADRs, frontend-integration.md, runbooks
```

## First-response confirmations (per implementation brief)

- **Stack**: TypeScript monorepo (pnpm workspaces), Fastify 5, Drizzle ORM + Postgres 16,
  BullMQ 5 + Redis 7, S3-compatible storage, Anchor (pinned) for the Solana program,
  `@solana/web3.js` v1 (pinned) for the client. OpenAPI-first: static
  `packages/contracts/openapi/v1.yaml` is the contract; the generated client must compile
  in CI; sample fixtures must validate against schemas.
- **Module boundaries**: business rules live in `packages/*` services, never in HTTP
  handlers. API actions and workers call the same authorization and state-transition
  functions. The generated client never imports database models.
- **Evidence/publication schema**: canonical payload (schemaVersion, subjectId,
  versionNumber, publicationKind, sections, lifecycleStatus+reason, timeline, claims,
  citation metadata, reviewedAt, intendedPublishedAt, previousPayloadHash, source
  snapshot digests) → product normalization (Unicode NFC, timestamp RFC3339, deterministic
  array order) → RFC 8785 JCS → SHA-256 → content-addressed object key. Verifier is
  standalone and runnable.
- **Sequence**: OpenAPI freeze first (Milestone 1), so frontend can build against a
  stable contract while the backend implements.

## Genuinely blocking missing inputs

| Input | Blocks | Without it |
|---|---|---|
| `SEARCH_PROVIDER_KEY` | search-adapter capability | adapter reports `unavailable`; nothing else breaks |
| `MODEL_PROVIDER_KEY` | AI research runs | runs stay queued/`awaiting_provider`; public reads of published content keep working |
| `SOLANA_RPC_URL`, `RECEIPT_PROGRAM_ID` | on-chain anchoring | receipt state `pending`/`unavailable`; publication itself is unaffected |
| Treasury + USDC mint config | Release B payments | payments stay disabled (`PAYMENTS_ENABLED=false`) |
| Admin identity for bootstrap | admin provisioning | no admin route access until the audited bootstrap command runs |

## Quick start (dev)

```bash
cp .env.example .env
docker compose up -d postgres redis minio
pnpm install
pnpm db:migrate
pnpm db:seed        # clearly-labelled synthetic fixtures only
pnpm --filter @afterbyte/api dev
pnpm --filter @afterbyte/worker dev
```

See `docs/frontend-integration.md` for the frontend contract and `docs/runbooks/` for
operations.
