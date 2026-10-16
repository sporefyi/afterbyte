#!/usr/bin/env node
/**
 * Assembles openapi/v1.yaml from fragment files:
 *   openapi/head.yaml            — info, servers, tags, securitySchemes,
 *                                   parameters, responses, and the start of
 *                                   components/schemas
 *   openapi/schemas-public.yaml  — public domain schemas (appended verbatim;
 *                                   continues the components.schemas mapping)
 *   openapi/schemas-domain.yaml  — identity/admin/payment schemas (same)
 *   /tmp is NOT used; path chunks live in openapi/paths/*.yaml
 *
 * v1.yaml is the checked-in source of truth. CI runs this script and fails
 * if the regenerated output differs from the checked-in file.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi');
const pathsDir = join(dir, 'paths');

const CHUNK_ORDER = [
  'public-a.yaml',
  'public-b.yaml',
  'public-c.yaml',
  'public-d.yaml',
  'public-sse.yaml',
  'identity-a.yaml',
  'identity-b.yaml',
  'identity-c.yaml',
  'admin-a.yaml',
  'admin-b.yaml',
  'payments.yaml',
];

// Sanity: every expected chunk exists, no unexpected chunks.
const present = new Set(readdirSync(pathsDir).filter((f) => f.endsWith('.yaml')));
for (const c of CHUNK_ORDER) {
  if (!present.has(c)) throw new Error(`missing path chunk: openapi/paths/${c}`);
  present.delete(c);
}
if (present.size > 0) {
  throw new Error(`unexpected path chunk(s): ${[...present].join(', ')}`);
}

const head = readFileSync(join(dir, 'head.yaml'), 'utf8');
if (!head.includes('paths: {}')) {
  throw new Error('head.yaml must contain the placeholder line "paths: {}"');
}

const indent2 = (text) =>
  text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : '  ' + line))
    .join('\n');

const chunks = CHUNK_ORDER.map((c) =>
  readFileSync(join(pathsDir, c), 'utf8').replace(/\s+$/, ''),
).join('\n');

const withPaths = head.replace('paths: {}', () => 'paths:\n' + indent2(chunks));

const schemaFragments = ['schemas-public.yaml', 'schemas-domain.yaml'].map((f) =>
  readFileSync(join(dir, f), 'utf8').replace(/\s+$/, ''),
);

const out =
  withPaths.replace(/\s+$/, '') +
  '\n' +
  schemaFragments.join('\n') +
  '\n';

mkdirSync(dir, { recursive: true });
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = outArg ? outArg.slice('--out='.length) : join(dir, 'v1.yaml');
writeFileSync(outPath, out);
console.log(`assembled ${outPath} (${out.split('\n').length} lines)`);
