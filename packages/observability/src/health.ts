/**
 * Health probe content builders.
 *
 * - /health/live: process is up. No dependency checks.
 * - /health/ready: reflects ONLY needed deps — the database is required;
 *   Redis and object storage are optional capabilities and reported as
 *   degraded rather than failing readiness (public reads must survive
 *   their absence).
 */

export type DependencyStatus = 'ok' | 'degraded' | 'down';

export interface DependencyCheck {
  name: string;
  status: DependencyStatus;
  latencyMs?: number;
  detail?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: DependencyCheck[];
  version: string;
  uptimeSeconds: number;
}

export function buildReadiness(checks: DependencyCheck[], version: string, uptimeSeconds: number): ReadinessReport {
  const required = checks.filter((c) => c.name === 'database');
  const status = required.every((c) => c.status === 'ok') ? 'ready' : 'not_ready';
  return { status, checks, version, uptimeSeconds };
}

export interface LivenessReport {
  status: 'live';
  version: string;
  uptimeSeconds: number;
}

export function buildLiveness(version: string, uptimeSeconds: number): LivenessReport {
  return { status: 'live', version, uptimeSeconds };
}
