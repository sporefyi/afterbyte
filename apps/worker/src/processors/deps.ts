import type { OutboxStore } from '../db.js';
import type { ResearchPackage } from '../adapters/research.js';
import type { Logger } from '../logging.js';
import type { JobEnvelope } from '../queues.js';

export interface ProcessorDeps {
  outbox: OutboxStore;
  research: ResearchPackage;
  logger: Logger;
  workerId: string;
  now?: () => string;
}

export type JobLike<T extends JobEnvelope> = {
  data: T;
  attemptsMade: number;
};
