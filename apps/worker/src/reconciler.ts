import type { ReceiptStore, Tx } from './db.js';
import type { Logger } from './logging.js';
import type { SolanaPackage } from './adapters/solana.js';
import type { PublicationKindLabel } from '@afterbyte/solana';
import type { PublicationReceipt, ReceiptStatus, TxAttempt } from './types.js';
import { PermanentError, TransientError } from './errors.js';

export interface ReconcilerDeps {
  receipts: ReceiptStore;
  solana: SolanaPackage;
  rpcUrls: string[];
  logger: Logger;
  now?: () => string;
}

export interface AnchorOutcome {
  status: ReceiptStatus;
  signature: string | null;
  note: string;
}

export interface RecheckOutcome {
  status: ReceiptStatus;
  changed: boolean;
  note: string;
}

export async function withRpcFallback<T>(
  rpcUrls: string[],
  logger: Logger,
  fn: (rpcUrl: string) => Promise<T>
): Promise<T> {
  const errors: Array<{ url: string; error: unknown }> = [];

  for (const url of rpcUrls) {
    try {
      return await fn(url);
    } catch (err) {
      logger.warn('RPC call failed', { url, error: String(err) });
      errors.push({ url, error: err });
    }
  }

  const message = errors
    .map(({ url, error }) => `${url}: ${String(error)}`)
    .join('; ');
  throw new TransientError(`All RPCs failed: ${message}`);
}

export function classifySignatureResult(
  raw: { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; slot: number; err: unknown } | null
): { state: 'finalized' | 'confirmed' | 'pending' | 'failed' | 'unknown'; slot: number | null } {
  if (raw === null) {
    return { state: 'unknown', slot: null };
  }

  if (raw.err !== null && raw.err !== undefined) {
    return { state: 'failed', slot: raw.slot };
  }

  switch (raw.confirmationStatus) {
    case 'finalized':
      return { state: 'finalized', slot: raw.slot };
    case 'confirmed':
      return { state: 'confirmed', slot: raw.slot };
    case 'processed':
      return { state: 'pending', slot: raw.slot };
    default:
      return { state: 'unknown', slot: raw.slot };
  }
}

export async function anchorReceipt(
  deps: ReconcilerDeps,
  input: { subjectId: string; versionNumber: number; payloadHash: string; publicationKind?: PublicationKindLabel }
): Promise<AnchorOutcome> {
  const { receipts, solana, rpcUrls, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const { subjectId, versionNumber, payloadHash, publicationKind } = input;
  const log = logger.child({ subjectId, versionNumber });

  // (a) No RPC configured
  if (rpcUrls.length === 0) {
    await receipts.transaction(async (tx) => {
      await upsertReceiptHelper(tx, receipts, {
        subjectId,
        versionNumber,
        payloadHash,
        publicationKind: publicationKind ?? null,
        status: 'unavailable',
        signature: null,
        slot: null,
        finalizedAt: null,
        updatedAt: now(),
      });
    });
    return { status: 'unavailable', signature: null, note: 'no RPC configured' };
  }

  // (b) Derive receipt address and check on-chain account
  const receiptAddress = await solana.deriveReceiptAddress(subjectId, versionNumber);

  let existingAccount: { payloadHash: string; versionNumber: number } | null = null;
  try {
    existingAccount = await withRpcFallback(rpcUrls, log, (url) =>
      solana.getReceiptAccount(url, receiptAddress)
    );
  } catch (err) {
    log.warn('Failed to check receipt account', { error: String(err) });
    // Continue — we'll try to submit
  }

  if (existingAccount !== null) {
    if (existingAccount.payloadHash === payloadHash) {
      // Idempotent success
      await receipts.transaction(async (tx) => {
        await upsertReceiptHelper(tx, receipts, {
          subjectId,
          versionNumber,
          payloadHash,
        publicationKind: publicationKind ?? null,
          status: 'finalized',
          signature: null,
          slot: null,
          finalizedAt: now(),
          updatedAt: now(),
        });
      });
      return { status: 'finalized', signature: null, note: 'already anchored on-chain' };
    } else {
      // Payload conflict
      await receipts.transaction(async (tx) => {
        await upsertReceiptHelper(tx, receipts, {
          subjectId,
          versionNumber,
          payloadHash,
        publicationKind: publicationKind ?? null,
          status: 'failed',
          signature: null,
          slot: null,
          finalizedAt: null,
          updatedAt: now(),
        });
      });
      throw new PermanentError(`payload-conflict: on-chain hash ${existingAccount.payloadHash} differs from ${payloadHash}`);
    }
  }

  // (c) Check prior attempts
  const priorAttempts = await receipts.transaction((tx) =>
    receipts.listAttemptsForReceipt(tx, subjectId, versionNumber)
  );

  const pendingAttempt = priorAttempts
    .filter((a) => (a.status === 'submitted' || a.status === 'confirmed') && a.signature)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (pendingAttempt) {
    let sigStatus: { state: 'finalized' | 'confirmed' | 'pending' | 'failed' | 'unknown'; slot: number | null };
    try {
      const raw = await withRpcFallback(rpcUrls, log, (url) =>
        solana.getSignatureStatus(url, pendingAttempt.signature)
      );
      sigStatus = classifySignatureResult(raw);
    } catch (err) {
      log.warn('Failed to check signature status', { signature: pendingAttempt.signature, error: String(err) });
      sigStatus = { state: 'unknown', slot: null };
    }

    if (sigStatus.state === 'finalized') {
      await receipts.transaction(async (tx) => {
        await receipts.updateTxAttempt(tx, pendingAttempt.id, { status: 'finalized', slot: sigStatus.slot });
        await upsertReceiptHelper(tx, receipts, {
          subjectId,
          versionNumber,
          payloadHash,
        publicationKind: publicationKind ?? null,
          status: 'finalized',
          signature: pendingAttempt.signature,
          slot: sigStatus.slot,
          finalizedAt: now(),
          updatedAt: now(),
        });
      });
      return { status: 'finalized', signature: pendingAttempt.signature, note: 'prior attempt finalized' };
    }

    if (sigStatus.state === 'confirmed') {
      await receipts.transaction(async (tx) => {
        await receipts.updateTxAttempt(tx, pendingAttempt.id, { status: 'confirmed', slot: sigStatus.slot });
        await upsertReceiptHelper(tx, receipts, {
          subjectId,
          versionNumber,
          payloadHash,
        publicationKind: publicationKind ?? null,
          status: 'confirmed',
          signature: pendingAttempt.signature,
          slot: sigStatus.slot,
          finalizedAt: null,
          updatedAt: now(),
        });
      });
      return { status: 'confirmed', signature: pendingAttempt.signature, note: 'prior attempt confirmed, awaiting finalization' };
    }

    if (sigStatus.state === 'failed') {
      await receipts.transaction(async (tx) => {
        await receipts.updateTxAttempt(tx, pendingAttempt.id, { status: 'failed', slot: sigStatus.slot, error: 'on-chain failure' });
      });
      // Continue to fresh submit
    }

    if (sigStatus.state === 'unknown') {
      // Check receipt account once more
      try {
        const accountCheck = await withRpcFallback(rpcUrls, log, (url) =>
          solana.getReceiptAccount(url, receiptAddress)
        );
        if (accountCheck !== null) {
          if (accountCheck.payloadHash === payloadHash) {
            await receipts.transaction(async (tx) => {
              await receipts.updateTxAttempt(tx, pendingAttempt.id, { status: 'finalized', slot: null });
              await upsertReceiptHelper(tx, receipts, {
                subjectId,
                versionNumber,
                payloadHash,
        publicationKind: publicationKind ?? null,
                status: 'finalized',
                signature: pendingAttempt.signature,
                slot: null,
                finalizedAt: now(),
                updatedAt: now(),
              });
            });
            return { status: 'finalized', signature: pendingAttempt.signature, note: 'receipt account found on recheck' };
          } else {
            await receipts.transaction(async (tx) => {
              await upsertReceiptHelper(tx, receipts, {
                subjectId,
                versionNumber,
                payloadHash,
        publicationKind: publicationKind ?? null,
                status: 'failed',
                signature: null,
                slot: null,
                finalizedAt: null,
                updatedAt: now(),
              });
            });
            throw new PermanentError(`payload-conflict: on-chain hash ${accountCheck.payloadHash} differs from ${payloadHash}`);
          }
        }
      } catch (err) {
        if (err instanceof PermanentError) throw err;
        log.warn('Failed to recheck receipt account', { error: String(err) });
      }
      // Proceed to fresh submit
    }
  }

  // (d) Fresh submit
  let attemptId: string;
  let usedRpcUrl: string = rpcUrls[0]!;

  await receipts.transaction(async (tx) => {
    const attempt = await receipts.recordTxAttempt(tx, {
      subjectId,
      versionNumber,
      signature: '',
      slot: null,
      status: 'submitted',
      rpcUrl: usedRpcUrl,
      error: null,
    });
    attemptId = attempt.id;
  });

  let signature: string;
  try {
    const result = await withRpcFallback(rpcUrls, log, async (url) => {
      usedRpcUrl = url;
      return solana.submitAnchor(url, { subjectId, versionNumber, payloadHash, publicationKind });
    });
    signature = result.signature;
  } catch (err) {
    // Unknown outcome — leave attempt as 'submitted', recheck will resolve
    log.error('submitAnchor failed', { error: String(err) });
    throw new TransientError(`submitAnchor failed: ${String(err)}`);
  }

  await receipts.transaction(async (tx) => {
    await receipts.updateTxAttempt(tx, attemptId!, { status: 'submitted', slot: null, signature });
    await upsertReceiptHelper(tx, receipts, {
      subjectId,
      versionNumber,
      payloadHash,
        publicationKind: publicationKind ?? null,
      status: 'submitted',
      signature,
      slot: null,
      finalizedAt: null,
      updatedAt: now(),
    });
  });

  return { status: 'submitted', signature, note: 'transaction submitted' };
}

export async function recheckReceipt(
  deps: ReconcilerDeps,
  input: { subjectId: string; versionNumber: number }
): Promise<RecheckOutcome> {
  const { receipts, solana, rpcUrls, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const { subjectId, versionNumber } = input;
  const log = logger.child({ subjectId, versionNumber });

  const receipt = await receipts.transaction((tx) =>
    receipts.getReceipt(tx, subjectId, versionNumber)
  );

  if (receipt === null) {
    return { status: 'pending', changed: false, note: 'no receipt row' };
  }

  if (receipt.status === 'finalized') {
    return { status: 'finalized', changed: false, note: 'already finalized' };
  }

  if (receipt.status === 'failed') {
    return { status: 'failed', changed: false, note: 'already failed' };
  }

  if (receipt.status === 'unavailable' && rpcUrls.length > 0) {
    const outcome = await anchorReceipt(deps, {
      subjectId,
      versionNumber,
      payloadHash: receipt.payloadHash,
      publicationKind: (receipt.publicationKind ?? undefined) as PublicationKindLabel | undefined,
    });
    return { status: outcome.status, changed: true, note: `re-anchored: ${outcome.note}` };
  }

  if (rpcUrls.length === 0) {
    return { status: receipt.status, changed: false, note: 'no RPC configured' };
  }

  const attempts = await receipts.transaction((tx) =>
    receipts.listAttemptsForReceipt(tx, subjectId, versionNumber)
  );

  const newestWithSig = attempts
    .filter((a) => a.signature)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (!newestWithSig) {
    return { status: receipt.status, changed: false, note: 'no attempts with signature' };
  }

  let sigStatus: { state: 'finalized' | 'confirmed' | 'pending' | 'failed' | 'unknown'; slot: number | null };
  try {
    const raw = await withRpcFallback(rpcUrls, log, (url) =>
      solana.getSignatureStatus(url, newestWithSig.signature)
    );
    sigStatus = classifySignatureResult(raw);
  } catch (err) {
    log.warn('Failed to check signature status during recheck', { error: String(err) });
    sigStatus = { state: 'unknown', slot: null };
  }

  if (sigStatus.state === 'finalized') {
    await receipts.transaction(async (tx) => {
      await receipts.updateTxAttempt(tx, newestWithSig.id, { status: 'finalized', slot: sigStatus.slot });
      await upsertReceiptHelper(tx, receipts, {
        ...receipt,
        status: 'finalized',
        slot: sigStatus.slot,
        finalizedAt: now(),
        updatedAt: now(),
      });
    });
    return { status: 'finalized', changed: true, note: 'finalized on recheck' };
  }

  if (sigStatus.state === 'confirmed') {
    await receipts.transaction(async (tx) => {
      await receipts.updateTxAttempt(tx, newestWithSig.id, { status: 'confirmed', slot: sigStatus.slot });
      await upsertReceiptHelper(tx, receipts, {
        ...receipt,
        status: 'confirmed',
        slot: sigStatus.slot,
        updatedAt: now(),
      });
    });
    return { status: 'confirmed', changed: receipt.status !== 'confirmed', note: 'confirmed, awaiting finalization' };
  }

  if (sigStatus.state === 'failed') {
    await receipts.transaction(async (tx) => {
      await receipts.updateTxAttempt(tx, newestWithSig.id, { status: 'failed', slot: sigStatus.slot, error: 'on-chain failure' });
      await upsertReceiptHelper(tx, receipts, {
        ...receipt,
        status: 'failed',
        updatedAt: now(),
      });
    });
    return { status: 'failed', changed: true, note: 'transaction failed on-chain' };
  }

  // Unknown — verify receipt account
  const receiptAddress = await solana.deriveReceiptAddress(subjectId, versionNumber);
  let accountCheck: { payloadHash: string; versionNumber: number } | null = null;
  try {
    accountCheck = await withRpcFallback(rpcUrls, log, (url) =>
      solana.getReceiptAccount(url, receiptAddress)
    );
  } catch (err) {
    log.warn('Failed to check receipt account during recheck', { error: String(err) });
  }

  if (accountCheck !== null) {
    if (accountCheck.payloadHash === receipt.payloadHash) {
      await receipts.transaction(async (tx) => {
        await receipts.updateTxAttempt(tx, newestWithSig.id, { status: 'finalized', slot: null });
        await upsertReceiptHelper(tx, receipts, {
          ...receipt,
          status: 'finalized',
          finalizedAt: now(),
          updatedAt: now(),
        });
      });
      return { status: 'finalized', changed: true, note: 'receipt account found' };
    } else {
      await receipts.transaction(async (tx) => {
        await receipts.updateTxAttempt(tx, newestWithSig.id, { status: 'failed', error: 'payload-conflict' });
        await upsertReceiptHelper(tx, receipts, {
          ...receipt,
          status: 'failed',
          updatedAt: now(),
        });
      });
      return { status: 'failed', changed: true, note: 'payload-conflict detected' };
    }
  }

  // Check if attempt is older than 10 minutes
  const attemptAge = Date.now() - new Date(newestWithSig.createdAt).getTime();
  const tenMinutes = 10 * 60 * 1000;

  if (attemptAge > tenMinutes) {
    // Expired — build fresh attempt
    let usedRpcUrl = rpcUrls[0]!;
    let attemptId: string;

    await receipts.transaction(async (tx) => {
      const attempt = await receipts.recordTxAttempt(tx, {
        subjectId,
        versionNumber,
        signature: '',
        slot: null,
        status: 'submitted',
        rpcUrl: usedRpcUrl,
        error: null,
      });
      attemptId = attempt.id;
    });

    let signature: string;
    try {
      const result = await withRpcFallback(rpcUrls, log, async (url) => {
        usedRpcUrl = url;
        return solana.submitAnchor(url, { subjectId, versionNumber, payloadHash: receipt.payloadHash, publicationKind: (receipt.publicationKind ?? undefined) as PublicationKindLabel | undefined });
      });
      signature = result.signature;
    } catch (err) {
      log.error('submitAnchor failed during recheck retry', { error: String(err) });
      throw new TransientError(`submitAnchor failed: ${String(err)}`);
    }

    await receipts.transaction(async (tx) => {
      await receipts.updateTxAttempt(tx, attemptId!, { status: 'submitted', signature });
      await upsertReceiptHelper(tx, receipts, {
        ...receipt,
        status: 'submitted',
        signature,
        updatedAt: now(),
      });
    });

    return { status: 'submitted', changed: true, note: 'prior attempt expired, resubmitted' };
  }

  return { status: 'pending', changed: false, note: 'awaiting confirmation' };
}

export async function ensureTransferSettled(
  deps: ReconcilerDeps,
  input: { kind: 'payment' | 'refund'; referenceId: string; priorSignature: string | null; expectedAmount?: string }
): Promise<{ settled: boolean; status: 'finalized' | 'confirmed' | 'failed' | 'unknown' | 'none'; note: string }> {
  const { solana, rpcUrls, logger } = deps;
  const { priorSignature, kind, referenceId } = input;
  const log = logger.child({ kind, referenceId });

  if (priorSignature === null) {
    return { settled: false, status: 'none', note: 'no prior signature' };
  }

  if (rpcUrls.length === 0) {
    return { settled: false, status: 'unknown', note: 'no RPC configured — cannot verify settlement' };
  }

  let sigStatus: { state: 'finalized' | 'confirmed' | 'pending' | 'failed' | 'unknown'; slot: number | null };
  try {
    const raw = await withRpcFallback(rpcUrls, log, (url) =>
      solana.getSignatureStatus(url, priorSignature)
    );
    sigStatus = classifySignatureResult(raw);
  } catch (err) {
    log.warn('Failed to check transfer signature status', { signature: priorSignature, error: String(err) });
    return { settled: false, status: 'unknown', note: `RPC error: ${String(err)} — indeterminate — investigate before rebuilding` };
  }

  switch (sigStatus.state) {
    case 'finalized':
      return { settled: true, status: 'finalized', note: 'transfer finalized' };
    case 'confirmed':
      return { settled: false, status: 'confirmed', note: 'may still finalize — do NOT build another transfer' };
    case 'failed':
      return { settled: false, status: 'failed', note: 'transfer failed on-chain' };
    case 'pending':
      return { settled: false, status: 'unknown', note: 'transaction processed but not confirmed — indeterminate — investigate before rebuilding' };
    case 'unknown':
    default:
      return { settled: false, status: 'unknown', note: 'indeterminate — investigate before rebuilding' };
  }
}

async function upsertReceiptHelper(
  tx: Tx,
  receipts: ReceiptStore,
  receipt: PublicationReceipt
): Promise<void> {
  await receipts.upsertReceipt(tx, receipt);
}
