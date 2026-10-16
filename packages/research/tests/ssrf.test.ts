import { describe, expect, it } from 'vitest';
import { isBlockedIp, resolveAndValidate, SsrfBlockedError } from '../src/providers/ssrf.js';

describe('isBlockedIp', () => {
  const blocked = [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.4.9',
    '192.168.1.1',
    '169.254.169.254', // link-local + cloud metadata
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1', // benchmarking
    '192.0.2.1', // TEST-NET-1
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '2001:db8::1', // documentation
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.1.2.3', // IPv4-mapped private
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      expect(isBlockedIp(ip)).toBe(true);
    });
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => {
      expect(isBlockedIp(ip)).toBe(false);
    });
  }

  it('fails closed on garbage', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });
});

describe('resolveAndValidate', () => {
  it('rejects IP literals in blocked ranges without DNS', async () => {
    await expect(resolveAndValidate('127.0.0.1')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveAndValidate('10.1.2.3')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects non-canonical numeric host forms', async () => {
    await expect(resolveAndValidate('0x7f.0.0.1')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveAndValidate('2130706433')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveAndValidate('0177.0.0.1')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects malformed hostnames', async () => {
    await expect(resolveAndValidate('not a host!!!')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(resolveAndValidate('')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('accepts a public IP literal', async () => {
    await expect(resolveAndValidate('8.8.8.8')).resolves.toEqual(['8.8.8.8']);
  });
});
