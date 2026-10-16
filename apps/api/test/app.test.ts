import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { loadConfig, capabilitiesOf } from '../src/config.js';
import { buildApp, buildConfigPayload, defaultDependencies } from '../src/app.js';
import { MemoryStore } from '../src/services/memory-store.js';
import { createLogger } from '@afterbyte/observability';

const env = {
  APP_ENV: 'dev',
  SESSION_SECRET: 'test-secret-0123456789abcdef-test-secret',
  DATABASE_URL: 'postgres://afterbyte:secret@localhost:5432/afterbyte',
  PUBLIC_SITE_URL: 'https://afterbyte.example',
  API_ORIGIN: 'https://api.afterbyte.example',
  ALLOWED_ORIGINS: 'https://afterbyte.example',
  AFTERBYTE_SEED_FIXTURES: '1',
} as NodeJS.ProcessEnv;

let app: FastifyInstance;

beforeAll(async () => {
  const { config, warnings } = loadConfig(env);
  expect(warnings.length).toBeGreaterThan(0); // optional providers missing -> warnings, not failure
  const capabilities = capabilitiesOf(config);
  const log = createLogger({ service: 'test', level: 'silent' });
  const store = new MemoryStore({ seedFixtures: true, config: buildConfigPayload(config, capabilities) });
  app = await buildApp(defaultDependencies(config, capabilities, store, log));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function cookiesOf(res: { headers: Record<string, unknown> }): Record<string, string> {
  const setCookie = res.headers['set-cookie'];
  const out: Record<string, string> = {};
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie as string] : [];
  for (const c of arr) {
    const [pair] = (c as string).split(';');
    const [k, v] = pair.split('=');
    out[k.trim()] = (v ?? '').trim();
  }
  return out;
}

describe('system', () => {
  it('GET /health/live is up without dependencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('live');
  });

  it('GET /health/ready reflects only needed deps', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.find((c: { name: string }) => c.name === 'redis').status).toBe('degraded');
  });
});

describe('public reads', () => {
  it('GET /config reports real feature flags (payments off)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.features.paymentsEnabled).toBe(false);
    expect(body.data.features.tokenEnabled).toBe(false);
    expect(body.data.providerStatus.models).toBe('unavailable');
    expect(body.meta.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.meta.requestId);
  });

  it('GET /home serves the fixture read model with dataMode fixture', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/home' });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.dataMode).toBe('fixture');
    expect(res.json().data.headline).toBeTruthy();
  });

  it('GET /dossiers/:slug returns 404 for unknown slugs (no invented data)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dossiers/no-such-thing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET /dossiers/:slug serves the fixture dossier', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dossiers/example-project' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.slug).toBe('example-project');
  });

  it('canonical bytes skip the envelope and carry a digest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dossiers/example-project/versions/2/canonical' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['x-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers['digest']).toBeTruthy();
    // raw bytes, not the JSON envelope (the fixture bytes are JSON text)
    expect(res.body).toContain('"schemaVersion":1');
    expect(res.body).not.toContain('"meta"');
  });

  it('ETag + If-None-Match returns 304', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();
    const second = await app.inject({ method: 'GET', url: '/api/v1/config', headers: { 'if-none-match': etag } });
    expect(second.statusCode).toBe(304);
  });

  it('validation failures use the 422 VALIDATION_FAILED envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/dossiers?limit=500' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('private-looking query on /search/suggest requires q', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search/suggest' });
    expect(res.statusCode).toBe(422);
  });
});

describe('auth flow', () => {
  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  let sessionCookie = '';
  let csrfToken = '';

  it('issues a challenge bound to the address', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge', payload: { address } });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.message).toContain(address);
    expect(body.requestId).toBeTruthy();

    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(body.message), kp.secretKey));
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify',
      payload: { requestId: body.requestId, signature: sig },
    });
    expect(verify.statusCode).toBe(200);
    const vbody = verify.json().data;
    expect(vbody.address).toBe(address);
    expect(vbody.roles).toEqual(['reader']); // first signup is never admin
    const cookies = cookiesOf(verify);
    expect(cookies['ab_session']).toBeTruthy();
    expect(cookies['ab_csrf']).toBeTruthy();
    sessionCookie = `ab_session=${cookies['ab_session']}; ab_csrf=${cookies['ab_csrf']}`;
    csrfToken = vbody.csrfToken;
  });

  it('rejects a reused challenge (replay)', async () => {
    const ch = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge', payload: { address } });
    const { requestId, message } = ch.json().data;
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/verify', payload: { requestId, signature: sig } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/verify', payload: { requestId, signature: sig } });
    expect(second.statusCode).toBe(401);
  });

  it('GET /me works with the session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: sessionCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.address).toBe(address);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('rejects mutations without the CSRF header', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/bookmarks/11111111-1111-4111-8111-111111111111',
      headers: { cookie: sessionCookie },
      payload: { dossierSlug: 'example-project' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_FAILED');
  });

  it('accepts mutations with the double-submit CSRF token', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/bookmarks/11111111-1111-4111-8111-111111111111',
      headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken },
      payload: { dossierSlug: 'example-project' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.subjectId).toBe('11111111-1111-4111-8111-111111111111');
    const list = await app.inject({ method: 'GET', url: '/api/v1/me/bookmarks', headers: { cookie: sessionCookie } });
    expect(list.json().data).toHaveLength(1);
  });

  it('logout invalidates the session', async () => {
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: sessionCookie, 'x-csrf-token': csrfToken },
    });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: sessionCookie } });
    expect(me.statusCode).toBe(401);
  });
});

describe('admin + payments guards', () => {
  it('admin routes return 403 for reader sessions', async () => {
    const kp2 = nacl.sign.keyPair();
    const address2 = bs58.encode(kp2.publicKey);
    const ch = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge', payload: { address: address2 } });
    const { requestId, message } = ch.json().data;
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp2.secretKey));
    const v = await app.inject({ method: 'POST', url: '/api/v1/auth/verify', payload: { requestId, signature: sig } });
    const cookies = cookiesOf(v);
    const cookie = `ab_session=${cookies['ab_session']}; ab_csrf=${cookies['ab_csrf']}`;
    const csrf = v.json().data.csrfToken;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/research-runs',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('admin routes return 401 without any session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/research-runs' });
    expect(res.statusCode).toBe(401);
  });

  it('payment endpoints return 503 FEATURE_UNAVAILABLE when disabled', async () => {
    const kp3 = nacl.sign.keyPair();
    const address3 = bs58.encode(kp3.publicKey);
    const ch = await app.inject({ method: 'POST', url: '/api/v1/auth/challenge', payload: { address: address3 } });
    const { requestId, message } = ch.json().data;
    const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp3.secretKey));
    const v = await app.inject({ method: 'POST', url: '/api/v1/auth/verify', payload: { requestId, signature: sig } });
    const cookies = cookiesOf(v);
    const cookie = `ab_session=${cookies['ab_session']}; ab_csrf=${cookies['ab_csrf']}`;
    const csrf = v.json().data.csrfToken;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/investigation-orders',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('FEATURE_UNAVAILABLE');
  });
});
