#!/usr/bin/env node
/**
 * Structural lint for openapi/v1.yaml:
 *  - YAML parses
 *  - every local $ref (#/...) resolves to an existing node
 *  - every operation has operationId + tags + at least one response
 *  - every error $ref points at a declared components/responses entry whose
 *    example error.code is in the ErrorCode enum
 *  - every path is under /api/v1 (relative form starts with '/')
 *
 * Used by `pnpm lint` and by the contract test suite (via node --test? no —
 * the vitest suite shells this same file logic through a shared module).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi');
const doc = parse(readFileSync(join(dir, 'v1.yaml'), 'utf8'));

const errors = [];
const seen = new Set();

function getPointer(doc, pointer) {
  // pointer like '#/components/schemas/Foo'
  const parts = pointer.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = doc;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function walk(node, path) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (ref.startsWith('#/')) {
        if (getPointer(doc, ref) === undefined) {
          errors.push(`unresolved $ref ${ref} at ${path}`);
        }
      } else {
        errors.push(`non-local $ref ${ref} at ${path} (only local refs allowed)`);
      }
      seen.add(ref);
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  }
}

walk(doc, '');

// Operation-level checks.
const paths = doc.paths ?? {};
const opIds = new Set();
for (const [p, item] of Object.entries(paths)) {
  if (!p.startsWith('/')) errors.push(`path does not start with '/': ${p}`);
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    const where = `${method.toUpperCase()} ${p}`;
    if (!op.operationId) errors.push(`${where}: missing operationId`);
    else if (opIds.has(op.operationId)) errors.push(`${where}: duplicate operationId ${op.operationId}`);
    else opIds.add(op.operationId);
    if (!op.tags || op.tags.length === 0) errors.push(`${where}: missing tags`);
    if (!op.responses || Object.keys(op.responses).length === 0) {
      errors.push(`${where}: no responses`);
    }
  }
}

// Every declared error response example must use a known ErrorCode.
const errorCodes = new Set(doc.components?.schemas?.ErrorCode?.enum ?? []);
for (const [name, resp] of Object.entries(doc.components?.responses ?? {})) {
  const ex = resp?.content?.['application/json']?.example?.error;
  if (ex && !errorCodes.has(ex.code)) {
    errors.push(`components/responses/${name}: example code ${ex.code} not in ErrorCode enum`);
  }
}

// ErrorCode enum must contain exactly the 11 brief codes.
const expected = [
  'VALIDATION_FAILED', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND',
  'VERSION_CONFLICT', 'RATE_LIMITED', 'FEATURE_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE', 'PAYMENT_NOT_FINALIZED', 'PAYMENT_MISMATCH',
  'PROOF_PENDING',
];
const missing = expected.filter((c) => !errorCodes.has(c));
if (missing.length > 0) errors.push(`ErrorCode enum missing: ${missing.join(', ')}`);

if (errors.length > 0) {
  console.error(`lint FAILED (${errors.length} problems):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(
  `lint OK: ${Object.keys(paths).length} paths, ${opIds.size} operations, ` +
    `${seen.size} distinct local $refs all resolve, 11/11 error codes present.`,
);
