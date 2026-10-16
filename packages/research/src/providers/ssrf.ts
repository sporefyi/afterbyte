/**
 * SSRF-safe HTTP client for the website adapter (brief §6).
 *
 * Fetched pages are hostile input. This client:
 *  - allows only http/https on ports 80/443 (configurable allowlist),
 *  - resolves DNS itself and rejects any host whose addresses intersect
 *    private / loopback / link-local / metadata / internal / reserved ranges
 *    (IPv4 and IPv6),
 *  - connects to the pre-validated IP (no rebinding TOCTOU) while keeping the
 *    original hostname for SNI and the Host header,
 *  - re-validates DNS at every redirect hop,
 *  - caps redirects, bytes, and time,
 *  - supports conditional requests (ETag / Last-Modified).
 *
 * No credentials of the API/worker are ever attached to these requests.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookupAll } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { RedirectHop } from './types.js';

export type { RedirectHop };

export interface SafeFetchOptions {
  maxRedirects?: number; // default 5
  maxBodyBytes?: number; // default 2_000_000
  timeoutMs?: number; // default 15_000 per attempt
  allowedPorts?: number[]; // default [80, 443]
  etag?: string;
  lastModified?: string;
  userAgent?: string;
  signal?: AbortSignal;
  /**
   * Override the DNS resolver. Production default is the system resolver.
   * The override exists so tests can supply real answers when the sandbox
   * resolver is intercepted; the range-blocking logic always applies to
   * whatever the resolver returns.
   */
  dns?: DnsResolver;
}

/** Minimal resolver shape: hostname → validated address records. */
export type DnsResolver = (hostname: string) => Promise<Array<{ address: string }>>;

const systemResolver: DnsResolver = (hostname) => dnsLookupAll(hostname, { all: true, verbatim: true });

export interface SafeFetchResult {
  statusCode: number;
  finalUrl: string;
  redirectHistory: RedirectHop[];
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  contentHash: string; // sha256 hex of buffered bytes
  etag?: string;
  lastModified?: string;
  contentType?: string;
  notModified: boolean;
}

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export class SafeFetchError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------ */
/* IP range blocking                                                   */
/* ------------------------------------------------------------------ */

type V4Range = [number, number]; // [network, maskBits] as uint32

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // this host
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay (deprecated)
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true; // fail closed
  for (const [net, bits] of V4_BLOCKED) {
    const netInt = v4ToInt(net)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (netInt & mask)) return true;
  }
  return false;
}

/** Expand an IPv6 address to 8 hextets. Returns null on invalid input. */
function v6Expand(ip: string): number[] | null {
  // Strip zone id.
  const addr = ip.split('%')[0];
  // Reject IPv4-mapped/embedded forms here; handled separately.
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  for (const g of [...head, ...tail]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v6InCidr(groups: number[], cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const netGroups = v6Expand(net);
  if (!netGroups) return true; // fail closed
  let remaining = bits;
  for (let i = 0; i < 8; i++) {
    const take = Math.min(16, remaining);
    if (take <= 0) break;
    const mask = take === 16 ? 0xffff : (~0 << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (netGroups[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

const V6_BLOCKED_CIDRS = [
  '::1/128', // loopback
  '::/128', // unspecified
  '64:ff9b::/96', // IPv4/IPv6 translation
  '100::/64', // discard
  '2001:db8::/32', // documentation (not inside 2001::/23)
  'fc00::/7', // unique local
  'fe80::/10', // link local
  'ff00::/8', // multicast
];

/** True when the IP must never be connected to. Fail-closed on parse errors. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Blocked(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped or translated forms: judge by the embedded IPv4 address.
    const mapped = lower.match(/^(?:::ffff:|:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return v4Blocked(mapped[1]);
    const groups = v6Expand(lower);
    if (!groups) return true;
    return V6_BLOCKED_CIDRS.some((cidr) => v6InCidr(groups, cidr));
  }
  return true; // not an IP at all -> blocked
}

/* ------------------------------------------------------------------ */
/* Hostname validation + DNS                                           */
/* ------------------------------------------------------------------ */

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Resolve a hostname and return validated connect addresses.
 * Throws SsrfBlockedError for anything that must not be fetched.
 */
export async function resolveAndValidate(hostname: string, resolver: DnsResolver = systemResolver): Promise<string[]> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new SsrfBlockedError(`IP literal ${host} is in a blocked range`);
    }
    return [host];
  }
  // Reject sneaky non-canonical numeric forms (0x7f.1, 2130706433, 0177.0.0.1).
  if (/^[0-9a-fx.:]+$/i.test(host) && /\d/.test(host)) {
    throw new SsrfBlockedError(`non-canonical numeric host rejected: ${hostname}`);
  }
  if (!HOSTNAME_RE.test(host)) {
    throw new SsrfBlockedError(`invalid hostname: ${hostname}`);
  }
  let records: Array<{ address: string }>;
  try {
    records = await resolver(host);
  } catch (err) {
    throw new SafeFetchError(
      'DNS_FAILED',
      `DNS resolution failed for ${host}: ${(err as Error).message}`,
      true,
    );
  }
  if (records.length === 0) {
    throw new SafeFetchError('DNS_FAILED', `no DNS records for ${host}`, true);
  }
  const blocked = records.filter((r) => isBlockedIp(r.address));
  if (blocked.length > 0) {
    throw new SsrfBlockedError(
      `DNS for ${host} resolved to blocked address(es): ${blocked.map((r) => r.address).join(', ')}`,
    );
  }
  return records.map((r) => r.address);
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_UA = 'AFTERBYTE-research/0.1 (+https://afterbyte.example; research fetcher)';

/**
 * Internal request dispatcher. `options` is deliberately loose: https needs
 * TLS fields (servername) that http's RequestOptions type does not carry.
 */
type DispatchFn = (options: Record<string, unknown>, cb: (res: IncomingMessage) => void) => ClientRequest;

function pickRequestFn(protocol: string): DispatchFn {
  if (protocol === 'http:') return (options, cb) => httpRequest(options as never, cb);
  if (protocol === 'https:') return (options, cb) => httpsRequest(options as never, cb);
  throw new SsrfBlockedError(`protocol not allowed: ${protocol}`);
}

/**
 * Fetch a URL with SSRF protections. Follows redirects manually so every hop
 * is DNS-validated. Never throws SsrfBlockedError as retryable.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const {
    maxRedirects = 5,
    maxBodyBytes = 2_000_000,
    timeoutMs = 15_000,
    allowedPorts = [80, 443],
    userAgent = DEFAULT_UA,
  } = opts;

  const redirectHistory: RedirectHop[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new SafeFetchError('INVALID_URL', `not a valid URL: ${current}`, false);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SsrfBlockedError(`protocol not allowed: ${url.protocol}`);
    }
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!allowedPorts.includes(port)) {
      throw new SsrfBlockedError(`port not allowed: ${port}`);
    }
    if (url.username || url.password) {
      throw new SsrfBlockedError('URL credentials are not allowed');
    }

    // Validate DNS at connection time (and at every redirect).
    const addresses = await resolveAndValidate(url.hostname, opts.dns);
    const connectIp = addresses[0];
    const requestFn = pickRequestFn(url.protocol);

    const result = await oneAttempt(url, connectIp, {
      timeoutMs,
      maxBodyBytes,
      userAgent,
      etag: opts.etag,
      lastModified: opts.lastModified,
      signal: opts.signal,
      requestFn,
    });

    if (result.statusCode >= 300 && result.statusCode < 400 && result.headers['location']) {
      if (hop === maxRedirects) {
        throw new SafeFetchError('TOO_MANY_REDIRECTS', `exceeded ${maxRedirects} redirects`, false);
      }
      redirectHistory.push({ url: current, status: result.statusCode, at: new Date().toISOString() });
      current = new URL(result.headers['location'], url).toString();
      // Conditional headers only apply to the original URL, not redirects.
      opts = { ...opts, etag: undefined, lastModified: undefined };
      continue;
    }

    const body = result.body;
    return {
      statusCode: result.statusCode,
      finalUrl: current,
      redirectHistory,
      headers: result.headers,
      body,
      truncated: result.truncated,
      contentHash: createHash('sha256').update(body).digest('hex'),
      etag: result.headers['etag'],
      lastModified: result.headers['last-modified'],
      contentType: result.headers['content-type'],
      notModified: result.statusCode === 304,
    };
  }
  throw new SafeFetchError('TOO_MANY_REDIRECTS', 'redirect loop', false);
}

interface AttemptResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

function oneAttempt(
  url: URL,
  connectIp: string,
  opts: {
    timeoutMs: number;
    maxBodyBytes: number;
    userAgent: string;
    etag?: string;
    lastModified?: string;
    signal?: AbortSignal;
    requestFn: DispatchFn;
  },
): Promise<AttemptResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': opts.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'identity',
    };
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;

    const req = opts.requestFn(
      {
        host: url.hostname, // Host header + SNI stay on the real hostname
        servername: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        // Connect to the DNS-validated IP: no rebinding TOCTOU.
        lookup: (_h: string, _o: unknown, cb: (err: Error | null, address: string, family: 4 | 6) => void) =>
          cb(null, connectIp, isIP(connectIp) as 4 | 6),
        timeout: opts.timeoutMs,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const outHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') outHeaders[k.toLowerCase()] = v;
          else if (Array.isArray(v)) outHeaders[k.toLowerCase()] = v.join(', ');
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (bytes + c.length > opts.maxBodyBytes) {
            const room = opts.maxBodyBytes - bytes;
            if (room > 0) {
              chunks.push(c.subarray(0, room));
              bytes += room;
            }
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
          bytes += c.length;
        });
        res.on('end', () => resolve({ statusCode, headers: outHeaders, body: Buffer.concat(chunks), truncated }));
        res.on('error', (e) => reject(new SafeFetchError('BODY_ERROR', e.message, true)));
      },
    );
    const onTimeout = () => {
      req.destroy(new SafeFetchError('TIMEOUT', `fetch timed out after ${opts.timeoutMs}ms`, true));
    };
    req.on('timeout', onTimeout);
    req.on('error', (e) => {
      if (e instanceof SafeFetchError) reject(e);
      else reject(new SafeFetchError('REQUEST_ERROR', e.message, true));
    });
    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy(new SafeFetchError('ABORTED', 'aborted by caller', false));
        return;
      }
      opts.signal.addEventListener('abort', () => req.destroy(new SafeFetchError('ABORTED', 'aborted by caller', false)), {
        once: true,
      });
    }
    req.end();
  });
}
