import { describe, it, expect } from 'vitest';
import { loadLangfuseConfig } from './config.js';

describe('loadLangfuseConfig', () => {
  it('returns a disabled config when env is empty', () => {
    const config = loadLangfuseConfig({});
    expect(config.enabled).toBe(false);
    expect(config.publicKey).toBeUndefined();
    expect(config.secretKey).toBeUndefined();
    expect(config.baseUrl).toBe('http://localhost:3001');
    expect(config.enableProxy).toBe(false);
    expect(config.sampleRate).toBe(1);
  });

  it('treats anything other than "true" as disabled', () => {
    expect(loadLangfuseConfig({ LANGFUSE_ENABLED: '1' }).enabled).toBe(false);
    expect(loadLangfuseConfig({ LANGFUSE_ENABLED: 'TRUE' }).enabled).toBe(
      false,
    );
    expect(loadLangfuseConfig({ LANGFUSE_ENABLED: 'false' }).enabled).toBe(
      false,
    );
  });

  it('returns a fully populated config when enabled with required keys', () => {
    const config = loadLangfuseConfig({
      LANGFUSE_ENABLED: 'true',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-abc',
      LANGFUSE_SECRET_KEY: 'sk-lf-xyz',
      LANGFUSE_BASE_URL: 'https://langfuse.example.com',
      LANGFUSE_PROXY_ENABLED: 'true',
      LANGFUSE_SAMPLE_RATE: '0.5',
    });
    expect(config).toEqual({
      enabled: true,
      publicKey: 'pk-lf-abc',
      secretKey: 'sk-lf-xyz',
      baseUrl: 'https://langfuse.example.com',
      enableProxy: true,
      sampleRate: 0.5,
    });
  });

  it('throws when enabled but missing publicKey', () => {
    expect(() =>
      loadLangfuseConfig({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_SECRET_KEY: 'sk-lf-xyz',
      }),
    ).toThrow(/LANGFUSE_PUBLIC_KEY/);
  });

  it('throws when enabled but missing secretKey', () => {
    expect(() =>
      loadLangfuseConfig({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_PUBLIC_KEY: 'pk-lf-abc',
      }),
    ).toThrow(/LANGFUSE_SECRET_KEY/);
  });

  it('lists every missing key in the error message', () => {
    expect(() =>
      loadLangfuseConfig({ LANGFUSE_ENABLED: 'true' }),
    ).toThrow(/LANGFUSE_PUBLIC_KEY.*LANGFUSE_SECRET_KEY/);
  });

  it('treats empty-string keys as missing', () => {
    expect(() =>
      loadLangfuseConfig({
        LANGFUSE_ENABLED: 'true',
        LANGFUSE_PUBLIC_KEY: '',
        LANGFUSE_SECRET_KEY: '',
      }),
    ).toThrow(/LANGFUSE_PUBLIC_KEY.*LANGFUSE_SECRET_KEY/);
  });

  it('rejects out-of-range sample rates', () => {
    expect(() =>
      loadLangfuseConfig({ LANGFUSE_SAMPLE_RATE: '2' }),
    ).toThrow(/LANGFUSE_SAMPLE_RATE/);
    expect(() =>
      loadLangfuseConfig({ LANGFUSE_SAMPLE_RATE: '-0.1' }),
    ).toThrow(/LANGFUSE_SAMPLE_RATE/);
    expect(() =>
      loadLangfuseConfig({ LANGFUSE_SAMPLE_RATE: 'not-a-number' }),
    ).toThrow(/LANGFUSE_SAMPLE_RATE/);
  });

  it('preserves keys in disabled mode without throwing', () => {
    const config = loadLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-abc',
      LANGFUSE_SECRET_KEY: 'sk-lf-xyz',
    });
    expect(config.enabled).toBe(false);
    expect(config.publicKey).toBe('pk-lf-abc');
    expect(config.secretKey).toBe('sk-lf-xyz');
  });

  it('reads from process.env when no argument is provided', () => {
    // Smoke test — we don't mutate process.env, just confirm the call shape works.
    const config = loadLangfuseConfig();
    expect(typeof config.enabled).toBe('boolean');
    expect(config.baseUrl).toBeDefined();
  });
});
