/**
 * Focused unit tests for `OpenSandboxProvider` constructor env-var fallback
 * and `parseEndpoint` URL/host parsing.
 *
 * Now that the provider speaks to the SDK (`Sandbox.create` +
 * `ConnectionConfig`) instead of `fetch`, the precedence matrix is asserted
 * by mocking the SDK module and capturing what's passed to
 * `new ConnectionConfig({...})`. URL parsing is tested directly via the
 * exported `parseEndpoint` pure function — no SDK plumbing required.
 *
 * The full SDK contract is exercised in
 * `opensandbox-provider.integration.test.ts` (gated, skipped by default).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface CapturedConnectionConfig {
  domain?: string;
  protocol?: string;
  apiKey?: string;
}

let capturedConnectionConfigs: CapturedConnectionConfig[];
let capturedCreateOpts: Array<{ connectionConfig?: unknown; image?: unknown }>;

vi.mock('@alibaba-group/opensandbox', () => {
  class ConnectionConfig {
    public readonly domain?: string;
    public readonly protocol?: string;
    public readonly apiKey?: string;
    public readonly requestTimeoutSeconds?: number;
    constructor(opts: CapturedConnectionConfig & { requestTimeoutSeconds?: number } = {}) {
      this.domain = opts.domain;
      this.protocol = opts.protocol;
      this.apiKey = opts.apiKey;
      this.requestTimeoutSeconds = opts.requestTimeoutSeconds;
      capturedConnectionConfigs.push({
        domain: opts.domain,
        protocol: opts.protocol,
        apiKey: opts.apiKey,
      });
    }
  }
  class SandboxApiException extends Error {
    public statusCode?: number;
    constructor(opts: { message?: string; statusCode?: number } = {}) {
      super(opts.message ?? 'SandboxApiException');
      this.statusCode = opts.statusCode;
    }
  }
  class FakeSandbox {
    readonly id: string;
    readonly commands = {
      run: vi.fn(async () => ({
        logs: { stdout: [], stderr: [] },
        result: [],
        exitCode: 0,
      })),
      runStream: vi.fn(),
      interrupt: vi.fn(),
      getCommandStatus: vi.fn(),
    };
    readonly files = {
      readBytes: vi.fn(),
      writeFiles: vi.fn(async () => undefined),
      createDirectories: vi.fn(async () => undefined),
      deleteFiles: vi.fn(),
      getFileInfo: vi.fn(),
    };
    constructor(id: string) {
      this.id = id;
    }
    static async create(opts: { connectionConfig?: unknown; image?: unknown }) {
      capturedCreateOpts.push(opts);
      return new FakeSandbox(`sbx-${capturedCreateOpts.length}`);
    }
    async kill() {
      /* noop */
    }
    async close() {
      /* noop */
    }
  }
  return {
    Sandbox: FakeSandbox,
    ConnectionConfig,
    SandboxApiException,
  };
});

// Import after mock registration so the real provider sees the mocked SDK.
import { OpenSandboxProvider, parseEndpoint } from './opensandbox-provider.js';

const ENV_KEYS = ['OPENSANDBOX_ENDPOINT', 'OPENSANDBOX_API_KEY'] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  capturedConnectionConfigs = [];
  capturedCreateOpts = [];
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

describe('parseEndpoint', () => {
  it('parses a full http URL', () => {
    expect(parseEndpoint('http://localhost:8080')).toEqual({
      protocol: 'http',
      domain: 'localhost:8080',
    });
  });

  it('parses a full https URL', () => {
    expect(parseEndpoint('https://api.example.com')).toEqual({
      protocol: 'https',
      domain: 'api.example.com',
    });
  });

  it('treats bare host:port as http (no scheme)', () => {
    expect(parseEndpoint('localhost:8080')).toEqual({
      protocol: 'http',
      domain: 'localhost:8080',
    });
  });

  it('treats bare host as http with default port elided', () => {
    expect(parseEndpoint('myhost.example')).toEqual({
      protocol: 'http',
      domain: 'myhost.example',
    });
  });

  it('strips trailing slashes', () => {
    expect(parseEndpoint('http://from-env:9999///')).toEqual({
      protocol: 'http',
      domain: 'from-env:9999',
    });
  });
});

describe('OpenSandboxProvider endpoint resolution', () => {
  it('uses constructor opt when both opt and env var are set (opt wins)', () => {
    process.env['OPENSANDBOX_ENDPOINT'] = 'http://from-env:9999';
    new OpenSandboxProvider({ endpoint: 'http://from-opt:1234' });
    expect(capturedConnectionConfigs[0]).toEqual(
      expect.objectContaining({ domain: 'from-opt:1234', protocol: 'http' }),
    );
  });

  it('falls back to OPENSANDBOX_ENDPOINT when constructor opt is undefined', () => {
    process.env['OPENSANDBOX_ENDPOINT'] = 'http://from-env:9999';
    new OpenSandboxProvider();
    expect(capturedConnectionConfigs[0]).toEqual(
      expect.objectContaining({ domain: 'from-env:9999', protocol: 'http' }),
    );
  });

  it('falls back to OPENSANDBOX_ENDPOINT when constructor passes empty opts object', () => {
    process.env['OPENSANDBOX_ENDPOINT'] = 'http://from-env:9999';
    new OpenSandboxProvider({});
    expect(capturedConnectionConfigs[0]).toEqual(
      expect.objectContaining({ domain: 'from-env:9999', protocol: 'http' }),
    );
  });

  it('uses http://localhost:8080 when neither opt nor env var is set', () => {
    new OpenSandboxProvider();
    expect(capturedConnectionConfigs[0]).toEqual(
      expect.objectContaining({ domain: 'localhost:8080', protocol: 'http' }),
    );
  });

  it('strips trailing slashes from the resolved endpoint', () => {
    process.env['OPENSANDBOX_ENDPOINT'] = 'http://from-env:9999///';
    new OpenSandboxProvider();
    expect(capturedConnectionConfigs[0]).toEqual(
      expect.objectContaining({ domain: 'from-env:9999', protocol: 'http' }),
    );
  });

  it('accepts a bare host:port without scheme', () => {
    process.env['OPENSANDBOX_ENDPOINT'] = 'cluster:8080';
    new OpenSandboxProvider();
    expect(capturedConnectionConfigs[0]).toEqual(
      expect.objectContaining({ domain: 'cluster:8080', protocol: 'http' }),
    );
  });
});

describe('OpenSandboxProvider apiKey resolution', () => {
  it('uses constructor opt when both opt and env var are set (opt wins)', () => {
    process.env['OPENSANDBOX_API_KEY'] = 'env-key';
    new OpenSandboxProvider({ apiKey: 'opt-key' });
    expect(capturedConnectionConfigs[0]?.apiKey).toBe('opt-key');
  });

  it('falls back to OPENSANDBOX_API_KEY when constructor opt is undefined', () => {
    process.env['OPENSANDBOX_API_KEY'] = 'env-key';
    new OpenSandboxProvider();
    expect(capturedConnectionConfigs[0]?.apiKey).toBe('env-key');
  });

  it('omits apiKey when neither opt nor env var is set', () => {
    new OpenSandboxProvider();
    expect(capturedConnectionConfigs[0]?.apiKey).toBeUndefined();
  });
});
