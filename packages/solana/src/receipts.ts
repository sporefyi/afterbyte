/**
 * Receipt-state helpers: map chain/transport observations to the product's
 * receipt states.
 *
 * States: pending → submitted → confirmed → finalized, plus failed and
 * unavailable (e.g. RPC unreachable). The public "Recorded on Solana" badge
 * requires `finalized` — nothing less.
 */

export type ReceiptState =
  | "pending"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "failed"
  | "unavailable";

export type ChainCommitment = "processed" | "confirmed" | "finalized";

export interface ChainObservation {
  /** Whether the RPC endpoint was reachable for this observation. */
  rpcReachable: boolean;
  /** Transaction-level error (e.g. simulation or send failure). */
  err?: unknown;
  /** Latest commitment observed for the transaction, if any. */
  commitment?: ChainCommitment;
  /** True if the transaction was accepted by the network (signature known). */
  signatureKnown?: boolean;
}

/**
 * Map a chain observation to a receipt state.
 *
 * Precedence: unreachable RPC → unavailable; tx error → failed; then the
 * strongest observed commitment wins.
 */
export function mapChainStateToReceiptState(obs: ChainObservation): ReceiptState {
  if (!obs.rpcReachable) return "unavailable";
  if (obs.err !== undefined && obs.err !== null) return "failed";
  switch (obs.commitment) {
    case "finalized":
      return "finalized";
    case "confirmed":
      return "confirmed";
    case "processed":
      return "submitted";
    default:
      return obs.signatureKnown ? "submitted" : "pending";
  }
}

/**
 * The "Recorded on Solana" public badge rule: ONLY finalized counts.
 * `confirmed` may be shown as "pending finality", never as recorded.
 */
export function isRecordedOnSolana(state: ReceiptState): boolean {
  return state === "finalized";
}

const DESCRIPTIONS: Record<ReceiptState, string> = {
  pending: "Receipt transaction not yet submitted.",
  submitted: "Transaction submitted; awaiting confirmation.",
  confirmed: "Confirmed by the network; pending finality.",
  finalized: "Recorded on Solana (finalized).",
  failed: "Receipt transaction failed.",
  unavailable: "Chain state unavailable (RPC unreachable).",
};

export function describeReceiptState(state: ReceiptState): string {
  return DESCRIPTIONS[state];
}
