import type { ApiConfig, Capabilities } from '../config.js';
import type { ReadStore } from '../services/store.js';
import type { ChallengeStore, SessionStore } from '../services/auth.service.js';
import type { Logger } from '@afterbyte/observability';

export interface RouteDeps {
  config: ApiConfig;
  capabilities: Capabilities;
  store: ReadStore;
  challenges: ChallengeStore;
  sessions: SessionStore;
  log: Logger;
}

export function dataModeOf(deps: RouteDeps): 'live' | 'fixture' {
  return deps.config.useFixtureSeed ? 'fixture' : 'live';
}
