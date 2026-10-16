import type { ProcessorDeps } from './deps.js';
import type { PublishStore, ReceiptStore, ReadModelStore, OpsStore } from '../db.js';
import type { StoragePackage } from '../adapters/storage.js';
import type { SolanaPackage } from '../adapters/solana.js';

export interface ProcessorDepsEx extends ProcessorDeps {
  publish: PublishStore;
  receipts: ReceiptStore;
  readmodels: ReadModelStore;
  ops: OpsStore;
  storage: StoragePackage;
  solana: SolanaPackage;
  rpcUrls: string[];
  paymentsEnabled: boolean;
}
