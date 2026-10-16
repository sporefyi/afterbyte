import { describe, expect, it } from "vitest";
import {
  describeReceiptState,
  isRecordedOnSolana,
  mapChainStateToReceiptState,
} from "../src/receipts.js";

describe("receipt state mapping", () => {
  it("maps commitments to states", () => {
    expect(mapChainStateToReceiptState({ rpcReachable: true, commitment: "finalized" })).toBe("finalized");
    expect(mapChainStateToReceiptState({ rpcReachable: true, commitment: "confirmed" })).toBe("confirmed");
    expect(mapChainStateToReceiptState({ rpcReachable: true, commitment: "processed" })).toBe("submitted");
  });

  it("maps signature-known without commitment to submitted", () => {
    expect(mapChainStateToReceiptState({ rpcReachable: true, signatureKnown: true })).toBe("submitted");
  });

  it("maps no information to pending", () => {
    expect(mapChainStateToReceiptState({ rpcReachable: true })).toBe("pending");
  });

  it("maps transaction errors to failed", () => {
    expect(mapChainStateToReceiptState({ rpcReachable: true, err: new Error("x") })).toBe("failed");
    // An error beats even a previously observed commitment.
    expect(
      mapChainStateToReceiptState({ rpcReachable: true, err: "send failed", commitment: "confirmed" })
    ).toBe("failed");
  });

  it("maps unreachable RPC to unavailable", () => {
    expect(mapChainStateToReceiptState({ rpcReachable: false })).toBe("unavailable");
    expect(
      mapChainStateToReceiptState({ rpcReachable: false, commitment: "finalized" })
    ).toBe("unavailable");
  });
});

describe("Recorded on Solana badge rule", () => {
  it("requires finalized — nothing less", () => {
    expect(isRecordedOnSolana("finalized")).toBe(true);
    expect(isRecordedOnSolana("confirmed")).toBe(false);
    expect(isRecordedOnSolana("submitted")).toBe(false);
    expect(isRecordedOnSolana("pending")).toBe(false);
    expect(isRecordedOnSolana("failed")).toBe(false);
    expect(isRecordedOnSolana("unavailable")).toBe(false);
  });

  it("describes every state", () => {
    for (const s of ["pending", "submitted", "confirmed", "finalized", "failed", "unavailable"] as const) {
      expect(typeof describeReceiptState(s)).toBe("string");
    }
    expect(describeReceiptState("finalized")).toContain("finalized");
  });
});
