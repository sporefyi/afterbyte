/**
 * OpenAPI conformance: every path+method in packages/contracts/openapi/v1.yaml
 * must have a registered Fastify route, and every /api/v1 route (plus the
 * /health probes) must exist in the contract. The contract is the source of
 * truth (ADR-0001); this test fails CI on drift in either direction.
 *
 * Route discovery parses app.printRoutes()'s radix tree and concatenates
 * segments back into full paths; {param} (contract) and :param (Fastify)
 * both normalize to :p for comparison.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as yaml from 'yaml';
import type { FastifyInstance } from 'fastify';
import { loadConfig, capabilitiesOf } from '../src/config.js';
import { buildApp, buildConfigPayload, defaultDependencies } from '../src/app.js';
import { MemoryStore } from '../src/services/memory-store.js';
import { createLogger } from '@afterbyte/observability';

const env = {
  APP_ENV: 'dev',
  SESSION_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgres://test:test@localhost:5432/afterbyte_test',
  PUBLIC_SITE_URL: 'https://afterbyte.example',
  API_ORIGIN: 'https://api.afterbyte.example',
  ALLOWED_ORIGINS: 'https://afterbyte.example',
} as NodeJS.ProcessEnv;

let app: FastifyInstance;

beforeAll(async () => {
  const { config } = loadConfig(env);
  const capabilities = capabilitiesOf(config);
  const log = createLogger({ service: 'test', level: 'silent' });
  const store = new MemoryStore({ seedFixtures: false, config: buildConfigPayload(config, capabilities) });
  app = await buildApp(defaultDependencies(config, capabilities, store, log));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function contractOps(): Set<string> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const yamlPath = join(testDir, '..', '..', '..', 'packages', 'contracts', 'openapi', 'v1.yaml');
  const doc = yaml.parse(readFileSync(yamlPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops = new Set<string>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    // /health/* probes live at the root; everything else is under /api/v1.
    const full = path.startsWith('/health') ? path : '/api/v1' + path;
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        ops.add(`${method.toUpperCase()} ${norm(full)}`);
      }
    }
  }
  return ops;
}

/** Parse printRoutes()'s radix tree back into (method, fullPath) pairs. */
function registeredOps(): Set<string> {
  const tree = app.printRoutes();
  const ops = new Set<string>();
  const stack: string[] = [];
  for (const rawLine of tree.split('\n')) {
    const line = rawLine.replace(/\u2500/g, ' ').replace(/\u251c/g, ' ').replace(/\u2514/g, ' ').replace(/\u2502/g, ' ');
    const m = line.match(/^(\s*)(\S.*)$/);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 4);
    let rest = m[2].trim();
    if (rest === '(empty root node)') {
      stack.length = 0;
      continue;
    }
    let methods: string[] = [];
    const pm = rest.match(/^(.*)\s+\(([A-Z,\s]+)\)$/);
    if (pm) {
      rest = pm[1].trim();
      methods = pm[2].split(',').map((s) => s.trim()).filter((s) => s !== 'HEAD');
    }
    stack.length = depth;
    stack.push(rest);
    if (methods.length > 0) {
      const full = stack.join('');
      for (const method of methods) ops.add(`${method} ${norm(full)}`);
    }
  }
  return ops;
}

function norm(p: string): string {
  return p.replace(/\{[^}]+\}/g, ':p').replace(/:[a-zA-Z_]+/g, ':p');
}

describe('OpenAPI conformance', () => {
  it('every contract operation has a registered route', () => {
    const missing = [...contractOps()].filter((op) => !registeredOps().has(op));
    expect(missing, `contract operations without a route: ${missing.join(', ')}`).toEqual([]);
  });

  it('every registered /api/v1 + /health route exists in the contract', () => {
    const contract = contractOps();
    const extra = [...registeredOps()].filter(
      (op) => {
        const path = op.slice(op.indexOf(' ') + 1);
        const inScope = path.startsWith('/api/v1/') || path.startsWith('/health');
        return inScope && !contract.has(op);
      },
    );
    expect(extra, `routes missing from the contract: ${extra.join(', ')}`).toEqual([]);
  });
});
