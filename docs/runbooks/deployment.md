# Deployment runbook

How to get AFTERBYTE from this repo to a running environment, and how to
promote between environments. All commands run from the repo root
(`/home/hatch/workspace/afterbyte`) unless noted.

## 1. Environments

| Environment | Purpose | APP_ENV | Data |
|---|---|---|---|
| dev | Local development | `dev` | Local Postgres + Redis (docker-compose), devnet RPC |
| staging | Pre-production verification | `staging` | Managed Postgres/Redis, devnet RPC |
| production | Live | `production` | Managed Postgres/Redis with PITR, mainnet RPC |

ADR-0003 governs environment/feature-flag discipline: `PAYMENTS_ENABLED`
and `TOKEN_ENABLED` stay `false` until their checklists (below) are complete
and verified. The API refuses to boot with payments half-configured (config
validation fails loudly at startup).

## 2. Prerequisites

- Node 20+, pnpm 9+, Docker (dev only).
- Postgres 15+, Redis 7+.
- `.env` copied from `.env.example` and filled. **No values are committed.**
  Core missing credentials fail the affected service clearly at startup;
  optional missing providers disable their capabilities (never block public
  reads of published content).

Minimum viable production `.env`:

```bash
APP_ENV=production
PUBLIC_SITE_URL=https://afterbyte.example
API_ORIGIN=https://api.afterbyte.example
ALLOWED_ORIGINS=https://afterbyte.example
DATABASE_URL=postgres://...
REDIS_URL=redis://...
SESSION_SECRET=<32+ random bytes>
OBJECT_STORAGE_ENDPOINT=...
OBJECT_STORAGE_BUCKET_PUBLIC=afterbyte-public
OBJECT_STORAGE_BUCKET_PRIVATE=afterbyte-private
OBJECT_STORAGE_ACCESS_KEY=...
OBJECT_STORAGE_SECRET_KEY=...
```

For receipt anchoring (Release A):

```bash
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=https://...
SOLANA_RPC_FALLBACK_URL=https://...
RECEIPT_PROGRAM_ID=<deployed program id>
PUBLISHER_SIGNER_REFERENCE=vault:projects/.../publisher-key/versions/1
```

> **No program deployment exists yet.** `RECEIPT_PROGRAM_ID` is empty until
> the program is built (`anchor build` needs Anchor CLI 0.30.1) and deployed.
> Never invent a program ID.

For research (optional capabilities):

```bash
SEARCH_PROVIDER_KEY=...
MODEL_PROVIDER_KEY=...
MODEL_PROVIDER_BASE_URL=...
MODEL_PROVIDER_MODEL_ID=...
```

## 3. Build

```bash
pnpm install
pnpm -r typecheck
pnpm -r build
pnpm -r test
```

Rust program (informational; skipped in JS CI):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo check   # passes; see programs/afterbyte-receipts/BUILD.md
# anchor build / anchor test need Anchor CLI 0.30.1 (not installed here)
```

## 4. Database migrations

Migrations live in `packages/database/` (Drizzle). The worker additionally
applies `apps/worker/src/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`,
safe to re-run) for its queue/inbox/outbox/read-model tables plus the
`research_*` tables.

Discipline (see `rollback-restore.md`):

1. **Expand first, contract later.** Additive changes (new tables, new
   nullable columns) deploy independently of code. Destructive changes
   (drop column/table) only after the code no longer reads them, in a
   separate release.
2. Run migrations against staging first; verify with `pnpm -r test`
   (DB integration tests run when `DATABASE_URL` is set, skip otherwise).
3. Back up before migrating production (PITR point noted).

## 5. Container deploy

Each service builds its own image (`apps/api`, `apps/worker`):

```bash
docker build -f apps/api/Dockerfile -t afterbyte/api:<version> .
docker build -f apps/worker/Dockerfile -t afterbyte/worker:<version> .
```

Rolling update order: **migrations → worker → API**. The worker owns the
outbox and read models; the API serves them. Health gates:

- `GET /health/live` — process alive.
- `GET /health/ready` — `ready` (or `degraded` when optional deps are
  missing); never expose a not-ready pod as serving.

## 6. First admin bootstrap (audited)

There is no self-signup to administrator. Roles are assigned by an audited
bootstrap, performed once per environment:

1. Deploy with `DATABASE_URL` reachable.
2. Insert the administrator account directly (audited — run from a shell
   with the command logged):
   ```sql
   -- replace <wallet-address> with the operator's wallet (base58)
   INSERT INTO user_accounts (wallet_address, role, created_at)
   VALUES ('<wallet-address>', 'administrator', now())
   ON CONFLICT (wallet_address) DO UPDATE SET role = 'administrator';
   ```
3. Verify: sign in with that wallet (`POST /auth/challenge` →
   `POST /auth/verify`) and call `GET /api/v1/admin/research/runs` —
   expect `200`, not `403 FORBIDDEN`.
4. Record the bootstrap in the change log (who, when, wallet address).

A dedicated `afterbyte-admin bootstrap` CLI is a planned follow-up; until
then the SQL above is the audited procedure. Never assign administrator
through any API endpoint.

## 7. Enabling payments (Release B) — checklist from ADR-0003

All boxes must be checked before `PAYMENTS_ENABLED=true` in any environment:

- [ ] Treasury wallet + USDC mint configured (`TREASURY_PUBLIC_KEY`, `USDC_MINT`)
      and verified on-chain (mint exists, treasury is a valid address).
- [ ] Quote/accept/order endpoints exercised end-to-end on devnet with real
      (devnet) funds; idempotency keys verified (double-POST returns the
      same award/order, no double charge).
- [ ] 503 `FEATURE_UNAVAILABLE` behavior verified with the flag OFF
      (frontend shows no payment CTA).
- [ ] Treasury capability (`requireCapability(TREASURY_CAPABILITY)`) verified:
      non-treasury admins get `403 FORBIDDEN` on payout/refund approval.
- [ ] Reconciliation job (payments lane) running and its dead-letter queue
      monitored.
- [ ] Operator trained on the payout/refund approval flow (`operator.md`).

Until then, `POST /api/v1/admin/awards`,
`POST /api/v1/admin/investigation-orders/{id}/accept`, and
`POST /api/v1/admin/investigation-orders/{id}/quote` return
`503 FEATURE_UNAVAILABLE` with the standard failure envelope.

## 8. Smoke test after deploy

```bash
curl -s $API_ORIGIN/health/live            # {"status":"live",...}
curl -s $API_ORIGIN/health/ready           # {"status":"ready"|"degraded",...}
curl -s $API_ORIGIN/api/v1/config          # 200, feature flags as expected
curl -s $API_ORIGIN/api/v1/home            # 200, published content renders
```
