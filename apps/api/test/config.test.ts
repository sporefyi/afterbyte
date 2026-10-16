import { describe, it, expect } from 'vitest';
import { loadConfig, capabilitiesOf, ConfigError } from '../src/config.js';

const base = {
  SESSION_SECRET: 'x'.repeat(40),
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
} as NodeJS.ProcessEnv;

describe('config', () => {
  it('fails clearly on missing core credentials', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    try {
      loadConfig({} as NodeJS.ProcessEnv);
    } catch (err) {
      expect((err as ConfigError).message).toContain('SESSION_SECRET');
    }
  });

  it('allows missing DATABASE_URL in dev (memory fallback), requires it in production', () => {
    const { config } = loadConfig({ SESSION_SECRET: 'x'.repeat(40), APP_ENV: 'dev' } as NodeJS.ProcessEnv);
    expect(config.databaseUrl).toBeNull();
    expect(() =>
      loadConfig({ SESSION_SECRET: 'x'.repeat(40), APP_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });

  it('rejects short session secrets and bad APP_ENV', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow(ConfigError);
  });

  it('loads with warnings when optional providers are missing', () => {
    const { config, warnings } = loadConfig({ ...base, APP_ENV: 'dev' });
    expect(config.appEnv).toBe('dev');
    expect(warnings.length).toBeGreaterThan(0);
    const caps = capabilitiesOf(config);
    expect(caps.payments).toBe(false);
    expect(caps.models).toBe(false);
    expect(caps.storage).toBe(false);
  });

  it('enables payments only with treasury + mint configured', () => {
    const { config } = loadConfig({
      ...base,
      PAYMENTS_ENABLED: 'true',
      TREASURY_PUBLIC_KEY: '11111111111111111111111111111111',
      USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
    expect(capabilitiesOf(config).payments).toBe(true);

    const { config: c2, warnings } = loadConfig({ ...base, PAYMENTS_ENABLED: 'true' });
    expect(capabilitiesOf(c2).payments).toBe(false);
    expect(warnings.some((w) => w.includes('PAYMENTS_ENABLED'))).toBe(true);
  });

  it('token capability stays off in Release A regardless of flag', () => {
    const { config } = loadConfig({ ...base, TOKEN_ENABLED: 'true' });
    expect(capabilitiesOf(config).token).toBe(false);
  });

  it('requires REDIS_URL in production, warns in dev', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'production' })).toThrow(ConfigError);
    const { warnings } = loadConfig({ ...base, APP_ENV: 'dev' });
    expect(warnings.some((w) => w.includes('REDIS_URL'))).toBe(true);
  });
});
