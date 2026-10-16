#!/usr/bin/env node
/**
 * Standalone AFTERBYTE receipt verifier CLI.
 *
 * Usage:
 *   pnpm --filter @afterbyte/solana verify -- <canonical-url> <expected-hash> \
 *     [--rpc <url>] [--program <base58>] [--subject <hex>] [--version <n>] \
 *     [--publisher <base58>]
 *
 * Exits 0 when every check passes, 1 otherwise. Prints a human summary plus
 * the full JSON report.
 */
import { verifyReceipt } from "../verifier.js";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

function usage(): string {
  return [
    "usage: verify -- <canonical-url> <expected-hash> [options]",
    "",
    "  <canonical-url>   URL serving the exact canonical payload bytes",
    "  <expected-hash>   expected SHA-256 hex of the canonical bytes",
    "",
    "options:",
    "  --rpc <url>        Solana JSON-RPC endpoint (default: mainnet-beta)",
    "  --program <base58> receipt program id (required)",
    "  --subject <hex>    64-char hex subject id (required)",
    "  --version <n>      receipt version number (required)",
    "  --publisher <b58>  expected publisher pubkey (optional)",
  ].join("\n");
}

function parseArgs(argv: string[]): Record<string, string> & { _: string[] } {
  const out: Record<string, string> = {};
  const positional: string[] = [];
  // pnpm forwards a literal "--" separator; drop it.
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return Object.assign(out, { _: positional });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [canonicalUrl, expectedHash] = args._;
  const program = args["program"];
  const subject = args["subject"];
  const versionRaw = args["version"];

  if (!canonicalUrl || !expectedHash || !program || !subject || !versionRaw) {
    console.error(usage());
    process.exit(2);
  }
  const version = Number(versionRaw);
  if (!Number.isInteger(version) || version < 1) {
    console.error("error: --version must be a positive integer");
    process.exit(2);
  }

  const report = await verifyReceipt({
    canonicalUrl,
    expectedPayloadHashHex: expectedHash,
    rpcUrl: args["rpc"] ?? DEFAULT_RPC,
    programId: program,
    subjectIdHex: subject,
    version,
    expectedPublisher: args["publisher"],
  });

  for (const c of report.checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
  }
  console.log(report.ok ? "\nVERIFIED: all checks passed" : "\nNOT VERIFIED: one or more checks failed");
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`verifier error: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
