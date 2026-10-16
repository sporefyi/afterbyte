# ADR-0003 — Environments and feature flags

Status: accepted · 2026-10-16

## Decision

- `APP_ENV`: `dev` | `staging` | `production`. Config validated on startup; core
  missing credentials fail the affected service with a clear error; optional missing
  providers disable their capabilities (`/config` reports real provider status).
- `PAYMENTS_ENABLED=false` default. Activation requires: confirmed treasury config,
  verified USDC mint, rate/fee policy, refund terms, reconciliation, passing
  settlement tests (brief §22 payment test list). No placeholder address may reach
  the browser; the frontend hides payment CTAs via `/config` feature flags.
- `TOKEN_ENABLED=false` default. No mint selection, no tokenomics, no transfers/
  burns/fees in the receipt program. Holdings (if ever enabled) grant product
  entitlements only — never editorial authority.
- Wallet sign-in enables personal actions only in Release A; funding flows are
  Release B and flagged off.
- Migrations: expand/backfill/contract; never destructive on production; CI blocks
  destructive migrations against production targets.

## Consequences

- Payments/accounting lanes implement interfaces + tests behind the flag; the UI
  contract documents the disabled states honestly (`FEATURE_UNAVAILABLE`).
- Release A public launch is mainnet-only after validation; local validators and an
  isolated staging cluster are validation environments and are never presented as
  the live deployment.
