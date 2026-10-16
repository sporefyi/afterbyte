/**
 * Contract tests for @afterbyte/contracts.
 *
 * These are the Milestone 1 contract gates:
 *  1. openapi/v1.yaml parses, all local $refs resolve, every operation has
 *     an operationId/tags/responses, and all 11 brief error codes exist.
 *  2. The checked-in v1.yaml is byte-identical to what the fragment
 *     assembler produces (no hand-edits to v1.yaml).
 *  3. Every fixture validates against its dereferenced YAML schema (ajv).
 *  4. The checked-in src/types.ts is byte-identical to what
 *     openapi-typescript regenerates from v1.yaml.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import * as formatsNs from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { AfterbyteClient, ApiError } from '../src/client.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const openapiDir = join(pkgDir, 'openapi');
const nodeBin = process.execPath;

function loadSpec(): any {
  return parseYaml(readFileSync(join(openapiDir, 'v1.yaml'), 'utf8'));
}

function getPointer(doc: any, pointer: string): any {
  const parts = pointer
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = doc;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function collectRefs(node: any, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectRefs(v, `${path}[${i}]`, out));
    return;
  }
  if (node !== null && typeof node === 'object') {
    if (typeof node.$ref === 'string') out.push(`${path} -> ${node.$ref}`);
    for (const [k, v] of Object.entries(node)) collectRefs(v, path ? `${path}.${k}` : k, out);
  }
}

/** Recursively inline local $refs; strip OpenAPI-only keywords ajv rejects. */
function deref(node: any, root: any): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, root));
  if (node !== null && typeof node === 'object') {
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      const { $ref, ...siblings } = node;
      const target = getPointer(root, $ref);
      if (target === undefined) throw new Error(`unresolved $ref in test deref: ${$ref}`);
      return { ...deref(target, root), ...deref(siblings, root) };
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'discriminator' || k === 'example' || k === 'examples' || k === 'xml' || k === 'externalDocs') continue;
      out[k] = deref(v, root);
    }
    return out;
  }
  return node;
}

const ajv = new Ajv({ strict: false, allErrors: true });
// ajv-formats is CJS without an "exports" map; reach the plugin via unknown.
const addFormats = (formatsNs as unknown as { default: (ajv: Ajv) => Ajv }).default;
addFormats(ajv);

function compileSchema(root: any, name: string) {
  return ajv.compile(deref(root.components.schemas[name], root));
}

describe('openapi/v1.yaml', () => {
  it('parses as OpenAPI 3.1 with the expected endpoint inventory', () => {
    const spec = loadSpec();
    expect(spec.openapi).toBe('3.1.0');
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBe(72);
    let ops = 0;
    for (const p of paths) {
      for (const m of Object.keys(spec.paths[p])) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) ops++;
      }
    }
    expect(ops).toBe(80);
  });

  it('every local $ref resolves', () => {
    const spec = loadSpec();
    const refs: string[] = [];
    collectRefs(spec, '', refs);
    expect(refs.length).toBeGreaterThan(200);
    const broken = refs.filter((r) => {
      const ref = r.split(' -> ')[1];
      if (!ref.startsWith('#/')) return true;
      return getPointer(spec, ref) === undefined;
    });
    expect(broken).toEqual([]);
  });

  it('every operation has operationId, tags and responses', () => {
    const spec = loadSpec();
    const opIds = new Set<string>();
    for (const [p, item] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        expect(op.operationId, `${method.toUpperCase()} ${p}`).toBeTruthy();
        expect(opIds.has(op.operationId), `duplicate ${op.operationId}`).toBe(false);
        opIds.add(op.operationId);
        expect(op.tags?.length, `${op.operationId} tags`).toBeGreaterThan(0);
        expect(Object.keys(op.responses ?? {}).length, `${op.operationId} responses`).toBeGreaterThan(0);
      }
    }
  });

  it('declares exactly the 11 brief error codes', () => {
    const spec = loadSpec();
    const codes: string[] = spec.components.schemas.ErrorCode.enum;
    expect(codes.sort()).toEqual(
      [
        'VALIDATION_FAILED', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND',
        'VERSION_CONFLICT', 'RATE_LIMITED', 'FEATURE_UNAVAILABLE',
        'PROVIDER_UNAVAILABLE', 'PAYMENT_NOT_FINALIZED', 'PAYMENT_MISMATCH',
        'PROOF_PENDING',
      ].sort(),
    );
  });

  it('checked-in v1.yaml matches the fragment assembler byte-for-byte', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ab-contract-'));
    const out = join(tmp, 'v1.yaml');
    execFileSync(nodeBin, [join(pkgDir, 'scripts', 'assemble-openapi.mjs'), `--out=${out}`], {
      stdio: 'pipe',
    });
    const expected = readFileSync(join(openapiDir, 'v1.yaml'), 'utf8');
    const actual = readFileSync(out, 'utf8');
    expect(actual).toBe(expected);
  });

  it('every error response example uses a known error code', () => {
    const spec = loadSpec();
    const codes = new Set<string>(spec.components.schemas.ErrorCode.enum);
    for (const [name, resp] of Object.entries<any>(spec.components.responses)) {
      const ex = resp?.content?.['application/json']?.example?.error;
      if (ex) expect(codes.has(ex.code), `responses/${name}`).toBe(true);
    }
  });
});

describe('fixtures', () => {
  it('dossier.json matches the brief section 13 shape exactly', () => {
    const spec = loadSpec();
    const fixture = JSON.parse(readFileSync(join(pkgDir, 'fixtures', 'dossier.json'), 'utf8'));
    // Explicitly labelled demo; production never serves fixtures.
    expect(fixture.meta.dataMode).toBe('demo');

    // Brief §13 key inventory — exact shape, no more, no less at top level.
    const briefKeys = [
      'id', 'slug', 'name', 'category', 'version', 'summary', 'lifecycleStatus',
      'statusReason', 'evidenceAssessment', 'publishedAt', 'lastReviewedAt',
      'lastObservedAt', 'nextReviewAt', 'heroAsset', 'sections', 'timelinePreview',
      'sourceCount', 'proof', 'availableMetrics', 'relationsPreview',
    ];
    expect(Object.keys(fixture.data).sort()).toEqual(briefKeys.sort());
    expect(fixture.data.sections.map((s: any) => s.id)).toEqual([
      'origin', 'peak', 'decline', 'now',
    ]);

    const validateData = compileSchema(spec, 'DossierDetail');
    expect(validateData(fixture.data), JSON.stringify(validateData.errors)).toBe(true);
    const validateMeta = compileSchema(spec, 'ResponseMeta');
    expect(validateMeta(fixture.meta), JSON.stringify(validateMeta.errors)).toBe(true);
  });

  it('error-envelope.json samples validate (all 11 codes covered)', () => {
    const spec = loadSpec();
    const fixture = JSON.parse(
      readFileSync(join(pkgDir, 'fixtures', 'error-envelope.json'), 'utf8'),
    );
    const validate = compileSchema(spec, 'ErrorEnvelope');
    const codes = new Set<string>();
    for (const sample of fixture.samples) {
      expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
      codes.add(sample.error.code);
    }
    const expected = new Set<string>(spec.components.schemas.ErrorCode.enum);
    expect(codes).toEqual(expected);
  });

  it('activity-event.json samples validate (sequenceId is a string)', () => {
    const spec = loadSpec();
    const fixture = JSON.parse(
      readFileSync(join(pkgDir, 'fixtures', 'activity-event.json'), 'utf8'),
    );
    const validate = compileSchema(spec, 'ActivityEvent');
    for (const sample of fixture.samples) {
      expect(validate(sample), JSON.stringify(validate.errors)).toBe(true);
      expect(typeof sample.sequenceId).toBe('string');
      expect(/^[0-9]+$/.test(sample.sequenceId)).toBe(true);
    }
    const types = fixture.samples.map((s: any) => s.eventType);
    expect(types).toContain('dossier.published');
    expect(types).toContain('receipt.finalized');
    expect(types).toContain('resync_required');
  });
});

describe('generated types', () => {
  it('src/types.ts matches openapi-typescript output byte-for-byte', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ab-types-'));
    const out = join(tmp, 'types.ts');
    const cli = join(pkgDir, 'node_modules', 'openapi-typescript', 'bin', 'cli.js');
    execFileSync(nodeBin, [cli, join(openapiDir, 'v1.yaml'), '--output', out], {
      stdio: 'pipe',
    });
    // Normalise line endings only; the generator is deterministic, so the
    // checked-in file must be byte-identical to a fresh regeneration.
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    const expected = norm(readFileSync(join(pkgDir, 'src', 'types.ts'), 'utf8'));
    const actual = norm(readFileSync(out, 'utf8'));
    expect(actual).toBe(expected);
  });

  it(
    'client type surface covers the dossier detail shape',
    () => {
      expect(typeof AfterbyteClient).toBe('function');
      expect(typeof ApiError).toBe('function');
      const c = new AfterbyteClient({ baseUrl: 'https://{API_ORIGIN}/api/v1' });
      for (const m of [
      'getConfig', 'getHome', 'listDossiers', 'getDossier', 'listDossierVersions',
      'getDossierVersion', 'getDossierVersionCanonical', 'getDossierTimeline',
      'getDossierSources', 'getDossierMetrics', 'getDossierRelations',
      'getDossierChanges', 'getCollection', 'suggestSearch', 'listActivity',
      'getStats', 'getReceipt', 'getMethodology', 'getServiceStatus',
      'getShareCard', 'streamEvents',
      'postAuthChallenge', 'postAuthVerify', 'postAuthLogout', 'getMe',
      'listBookmarks', 'putBookmark', 'deleteBookmark', 'listWatchlist',
      'putWatchlistItem', 'deleteWatchlistItem', 'listNotifications',
      'patchNotification', 'createSubmission', 'createCorrection',
      'listMySubmissions', 'listMyOrders',
      'listResearchRuns', 'createResearchRun', 'getResearchRun',
      'cancelResearchRun', 'retryResearchRun', 'listDrafts', 'getDraft',
      'patchDraft', 'submitDraftReview', 'approveDraft', 'publishDraft',
      'retractDossier', 'scheduleRecheck', 'listAdminSubmissions',
      'getAdminSubmission', 'moderateSubmission', 'listAdminCorrections',
      'getAdminCorrection', 'moderateCorrection', 'getHomeEdition',
      'patchHomeEdition', 'listProviders', 'getCosts', 'getQueues',
      'listAuditLog', 'listFailedReceipts', 'createUploadIntent', 'finalizeAsset',
      'createInvestigationOrder', 'getInvestigationOrder', 'acceptQuote',
      'createPaymentIntent', 'getPaymentIntent', 'submitPaymentSignature',
      'requestRefund', 'getRefund', 'adminAcceptOrder', 'adminCreateQuote',
      'adminApproveRefund', 'adminCreateAward',
    ]) {
      expect(typeof (c as any)[m], m).toBe('function');
      }
    },
    60000,
  );
});
