# Build & deploy notes — afterbyte-receipts

## Build status (2026-10-16)

**`cargo check` PASSES** (run 2026-10-16, this VM). A Rust toolchain was found
in `~/.cargo`/`~/.rustup` (not on the default PATH — export
`PATH="$HOME/.cargo/bin:$PATH"`):

- `rustc 1.98.1`, `cargo 1.98.1` (stable toolchain)
- `anchor-lang =0.30.1` + `solana-program 1.18.26` resolved from crates.io and
  compiled cleanly; `cargo check` on the program reports **0 errors**
  (only benign `unexpected cfg` warnings emitted by Anchor's macros, normal for
  host-target checks). The four compile-time size assertions
  (`Config::SIZE == 77`, `PublisherAuth::SIZE == 42`, `Subject::SIZE == 81`,
  `Receipt::SIZE == 164`) all hold. `Cargo.lock` is committed.
- Two real type errors were found and fixed during this check
  (`require_keys_eq!` needed `*ctx.program_id`, not `&Pubkey`).

**Not yet run:** `anchor build` (BPF `.so`) and `anchor test` — the Anchor CLI
(`avm`/`anchor`) and Solana platform tools are not installed here, and building
the on-chain BPF artifact requires them. Run `anchor build && anchor test` on a
machine with the pinned toolchain below before deploying.

## Pinned toolchain

| Component | Pinned version | Install |
|---|---|---|
| Anchor CLI | `0.30.1` | `avm install 0.30.1 && avm use 0.30.1` |
| anchor-lang (crate) | `=0.30.1` | via `Cargo.toml` |
| Solana toolchain | `1.18.x` | ships with / required by Anchor 0.30.1 |
| Rust | stable `>= 1.75` | `rustup toolchain install stable` |
| Node (for `anchor test`) | `>= 20.18.0` | repo engines field |
| @coral-xyz/anchor (tests) | `0.30.1` | `programs/afterbyte-receipts/package.json` |
| @solana/web3.js (tests) | `1.95.8` | same |

Build:

```bash
cd programs/afterbyte-receipts
anchor build        # produces target/deploy/afterbyte_receipts.so
anchor test         # localnet: builds, deploys, runs tests/afterbyte-receipts.ts
```

## Program id

`src/lib.rs` uses `declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLn")` —
the well-known Anchor example placeholder. **This repo has no deployment.**
Before deploying: generate a keypair
(`solana-keygen new -o target/deploy/afterbyte_receipts-keypair.json`), put its
pubkey in `declare_id!` and in `Anchor.toml` `[programs.<cluster>]`, then
`anchor build && anchor deploy --provider.cluster <cluster>`. Never invent a
program id; record the real one in the deployment manifest.

## Rent calculation (account sizes, 8-byte Anchor discriminator included)

| Account | Size (bytes) | Formula |
|---|---|---|
| Config | 77 | 8 + 2 + 32 + (1+32) + 1 + 1 |
| PublisherAuth | 42 | 8 + 32 + 1 + 1 |
| Subject | 81 | 8 + 32 + 8 + 32 + 1 |
| Receipt | 164 | 8 + 32 + 8 + 32 + 32 + 1 + 32 + 8 + 8 + 2 + 1 |

Compile-time assertions in `src/lib.rs` fail the build if a layout drifts.
At deployment preparation time, query rent on the **target cluster** — do not
reuse testnet values for mainnet:

```ts
const rent = await connection.getMinimumBalanceForRentExemption(164); // per receipt
```

Add a ~10% buffer in deployment scripts; re-query immediately before mainnet
deploy in case rent parameters changed.

## Upgrade authority disclosure

The program deploys as an upgradeable BPF program. After deployment:

1. Record the upgrade authority in `deploy/<cluster>-manifest.json` (copy
   `deploy/manifest.TEMPLATE.json`; **real values only after an actual
   deployment** — never placeholders presented as real).
2. Verify on-chain: `solana program show <PROGRAM_ID> --provider.cluster <cluster>`.
3. An append-only instruction interface does **not** protect against a
   privileged program upgrade. Revoking the upgrade authority
   (`solana program set-upgrade-authority <PROGRAM_ID> --final`) requires a
   separate explicit decision and is irreversible.

## What the program does NOT do

No custody, no token/mint logic, no transfers, no closing or updating of
receipts. `pause` blocks only `append_receipt`; admin functions keep working.
