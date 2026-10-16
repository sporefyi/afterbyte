/**
 * @afterbyte/solana — public API.
 *
 * The verifier (verifier.ts) is intentionally dependency-free (node built-ins
 * + canonicalize only) so it can run standalone; it is re-exported here for
 * convenience but has no web3.js or DB imports.
 */
export * from "./canonicalize.js";
export * from "./client.js";
export * from "./receipts.js";
export * from "./verifier.js";
export { RestrictedPublisherSigner, loadPublisherSignerReference } from "./signer.js";
export type { ApprovedAppend, RestrictedSignerConfig, SignFn } from "./signer.js";
