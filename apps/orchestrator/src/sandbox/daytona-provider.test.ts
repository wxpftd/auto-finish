/**
 * Unit tests for DaytonaProvider — these mock the Daytona SDK so they're
 * fast (< 100ms each) and have no dependency on a real Daytona instance.
 *
 * The full provider contract (echo round-trips, file IO, timeouts, etc.)
 * is exercised against a real Daytona in `daytona-provider.integration.test.ts`,
 * which is skipped by default.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  DaytonaProvider,
  quoteArg,
  quoteArgv,
} from './daytona-provider.js';
import {
  SandboxDestroyedError,
  SandboxFileNotFoundError,
  SandboxTimeoutError,
} from './in-memory-provider.js';

// ---------------------------------------------------------------------------
// Mock the SDK. We provide enough of the surface for the tests below: a
// `Daytona` constructor, plus a `DaytonaNotFoundError` class so the provider's
// SDK-error translation path works.
// ---------------------------------------------------------------------------

// `vi.mock` is hoisted to the top of the file, so the factory cannot
// reference module-level variables. We use `vi.hoisted` to create a
// shared "hoisted" namespace that both the factory and the tests can
// touch.
const hoisted = vi.hoisted(() => {
  class MockDaytonaNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DaytonaNotFoundError';
    }
  }
  return {
    MockDaytonaNotFoundError,
    state: {
      lastConfigPassedToConstructor: undefined as unknown,
      mockClient: undefined as unknown,
    },
  };
});

vi.mock('@daytonaio/sdk', () => {
  return {
    Daytona: vi.fn().mockImplementation((cfg: unknown) => {
      hoisted.state.lastConfigPassedToConstructor = cfg;
      return hoisted.state.mockClient;
    }),
    DaytonaNotFoundError: hoisted.MockDaytonaNotFoundError,
  };
});

interface MockProcess {
  createSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  executeSessionCommand: ReturnType<typeof vi.fn>;
}

interface MockFs {
  uploadFile: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
  createFolder: ReturnType<typeof vi.fn>;
}

interface MockSandbox {
  id: string;
  process: MockProcess;
  fs: MockFs;
}

interface MockDaytonaClient {
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

let mockClient: MockDaytonaClient;

function getLastConfigPassedToConstructor(): unknown {
  return hoisted.state.lastConfigPassedToConstructor;
}

function makeMockSandbox(id = 'sbx-1'): MockSandbox {
  return {
    id,
    process: {
      createSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      executeSessionCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: '',
      }),
    },
    fs: {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      downloadFile: vi.fn().mockResolvedValue(Buffer.from('')),
      createFolder: vi.fn().mockResolvedValue(undefined),
    },
  };
}

beforeEach(() => {
  hoisted.state.lastConfigPassedToConstructor = undefined;
  mockClient = {
    create: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  hoisted.state.mockClient = mockClient;
});

// ---------------------------------------------------------------------------

describe('quoteArg / quoteArgv', () => {
  it('leaves safe tokens unquoted', () => {
    expect(quoteArg('echo')).toBe('echo');
    expect(quoteArg('foo.txt')).toBe('foo.txt');
    expect(quoteArg('/etc/greeting')).toBe('/etc/greeting');
  });

  it('single-quotes tokens with spaces and shell metas', () => {
    expect(quoteArg('hello world')).toBe(`'hello world'`);
    expect(quoteArg('boom; rm -rf')).toBe(`'boom; rm -rf'`);
  });

  it('escapes embedded single quotes', () => {
    expect(quoteArg("it's fine")).toBe(`'it'\\''s fine'`);
  });

  it('quotes the empty string explicitly', () => {
    expect(quoteArg('')).toBe(`''`);
  });

  it('joins argv with spaces', () => {
    expect(quoteArgv(['echo', 'hello world'])).toBe(`echo 'hello world'`);
    expect(quoteArgv(['/bin/sh', '-c', 'boom'])).toBe(`/bin/sh -c boom`);
  });
});

describe('DaytonaProvider constructor', () => {
  it('forwards explicit opts to the SDK config', () => {
    new DaytonaProvider({
      apiUrl: 'http://localhost:3986/api',
      apiKey: 'k1',
      target: 'us',
    });
    expect(getLastConfigPassedToConstructor()).toEqual({
      apiUrl: 'http://localhost:3986/api',
      apiKey: 'k1',
      target: 'us',
    });
  });

  it('falls back to env vars when opts are omitted', () => {
    const prev = {
      url: process.env['DAYTONA_API_URL'],
      key: process.env['DAYTONA_API_KEY'],
      target: process.env['DAYTONA_TARGET'],
    };
    process.env['DAYTONA_API_URL'] = 'http://envurl';
    process.env['DAYTONA_API_KEY'] = 'envkey';
    process.env['DAYTONA_TARGET'] = 'envtarget';
    try {
      new DaytonaProvider();
      expect(getLastConfigPassedToConstructor()).toEqual({
        apiUrl: 'http://envurl',
        apiKey: 'envkey',
        target: 'envtarget',
      });
    } finally {
      if (prev.url === undefined) delete process.env['DAYTONA_API_URL'];
      else process.env['DAYTONA_API_URL'] = prev.url;
      if (prev.key === undefined) delete process.env['DAYTONA_API_KEY'];
      else process.env['DAYTONA_API_KEY'] = prev.key;
      if (prev.target === undefined) delete process.env['DAYTONA_TARGET'];
      else process.env['DAYTONA_TARGET'] = prev.target;
    }
  });

  it('constructs with no opts and no env vars (Daytona client gets {})', () => {
    const prev = {
      url: process.env['DAYTONA_API_URL'],
      key: process.env['DAYTONA_API_KEY'],
      target: process.env['DAYTONA_TARGET'],
    };
    delete process.env['DAYTONA_API_URL'];
    delete process.env['DAYTONA_API_KEY'];
    delete process.env['DAYTONA_TARGET'];
    try {
      new DaytonaProvider();
      expect(getLastConfigPassedToConstructor()).toEqual({});
    } finally {
      if (prev.url !== undefined) process.env['DAYTONA_API_URL'] = prev.url;
      if (prev.key !== undefined) process.env['DAYTONA_API_KEY'] = prev.key;
      if (prev.target !== undefined)
        process.env['DAYTONA_TARGET'] = prev.target;
    }
  });
});

describe('DaytonaProvider.create()', () => {
  it('calls SDK create with the given image and env, returns a session with the SDK sandbox id', async () => {
    const sbx = makeMockSandbox('sbx-abc');
    mockClient.create.mockResolvedValue(sbx);

    const provider = new DaytonaProvider();
    const session = await provider.create({
      image: 'debian:12',
      env: { FOO: 'bar', BAZ: 'qux' },
    });

    expect(mockClient.create).toHaveBeenCalledTimes(1);
    expect(mockClient.create).toHaveBeenCalledWith({
      image: 'debian:12',
      envVars: { FOO: 'bar', BAZ: 'qux' },
    });
    expect(session.id).toBe('sbx-abc');
    // Sanity: the happy path must NOT auto-destroy the sandbox. A
    // regression that always-deleted on every create would silently
    // wreck production.
    expect(mockClient.delete).not.toHaveBeenCalled();
  });

  it('runs setup_commands serially and does not destroy when they all succeed', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    });

    const provider = new DaytonaProvider();
    const session = await provider.create({
      setup_commands: ['mkdir -p /workspace', 'apt-get update -y'],
    });
    expect(sbx.process.executeSessionCommand).toHaveBeenCalledTimes(2);
    expect(mockClient.delete).not.toHaveBeenCalled();
    expect(session.id).toBe('sbx-1');
  });

  it('uses the default image when SandboxConfig.image is unset', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);

    const provider = new DaytonaProvider();
    await provider.create({});
    const args = mockClient.create.mock.calls[0]?.[0] as { image: string };
    expect(args).toBeDefined();
    expect(args.image).toMatch(/ubuntu/);
  });

  it('runs setup_commands serially after create and aborts on first failure', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'ok-1',
        stderr: '',
        output: 'ok-1',
      })
      .mockResolvedValueOnce({
        exitCode: 7,
        stdout: '',
        stderr: 'nope',
        output: 'nope',
      });

    const provider = new DaytonaProvider();
    await expect(
      provider.create({
        setup_commands: ['echo hi', 'false'],
      }),
    ).rejects.toThrow(/setup command failed/);

    // We expect createSession + 2 calls + deleteSession on the failure
    // path that destroy() runs.
    expect(sbx.process.createSession).toHaveBeenCalledTimes(1);
    expect(sbx.process.executeSessionCommand).toHaveBeenCalledTimes(2);
    const firstCall = sbx.process.executeSessionCommand.mock.calls[0];
    const secondCall = sbx.process.executeSessionCommand.mock.calls[1];
    expect(firstCall?.[1]).toMatchObject({
      command: "/bin/sh -c 'echo hi'",
      runAsync: false,
    });
    expect(secondCall?.[1]).toMatchObject({
      command: '/bin/sh -c false',
      runAsync: false,
    });
    expect(mockClient.delete).toHaveBeenCalledTimes(1);
  });
});

describe('DaytonaSession.run()', () => {
  it('translates argv into a quoted shell command on a long-lived session', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      output: 'hi\n',
    });

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    const r = await session.run(['echo', 'hi']);

    expect(r).toEqual({ exit_code: 0, stdout: 'hi\n', stderr: '' });
    expect(sbx.process.createSession).toHaveBeenCalledTimes(1);
    expect(sbx.process.executeSessionCommand).toHaveBeenCalledTimes(1);
    const call = sbx.process.executeSessionCommand.mock.calls[0];
    expect(call?.[0]).toBe('auto-finish-run');
    expect(call?.[1]).toMatchObject({
      command: 'echo hi',
      runAsync: false,
    });
  });

  it('returns separate stdout and stderr from the SDK response', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
      output: 'boom',
    });

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    const r = await session.run(['/bin/sh', '-c', 'boom']);
    expect(r.exit_code).toBe(1);
    expect(r.stderr).toContain('boom');
  });

  it('reuses the same Process session across multiple run() calls', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    });

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await session.run(['true']);
    await session.run(['true']);
    await session.run(['true']);

    expect(sbx.process.createSession).toHaveBeenCalledTimes(1);
    expect(sbx.process.executeSessionCommand).toHaveBeenCalledTimes(3);
  });

  it('synthesizes stream-lines locally without hitting the SDK', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    const r = await session.run(['stream-lines', 'a', 'b']);
    expect(r).toEqual({ exit_code: 0, stdout: 'a\nb\n', stderr: '' });
    expect(sbx.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it('enforces timeout_ms locally even if the SDK call is slow', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockImplementation(
      () => new Promise(() => {
        /* never resolves */
      }),
    );

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await expect(
      session.run(['true'], { timeout_ms: 30 }),
    ).rejects.toBeInstanceOf(SandboxTimeoutError);
  });

  it('applies cwd and env via the composed shell command', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    });

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await session.run(['echo', 'x'], {
      cwd: '/workspace',
      env: { K: 'v', K2: 'v 2' },
    });
    const call = sbx.process.executeSessionCommand.mock.calls[0];
    const cmd = (call?.[1] as { command: string }).command;
    expect(cmd).toContain('cd /workspace && ');
    expect(cmd).toContain('K=v ');
    expect(cmd).toContain(`K2='v 2'`);
    expect(cmd).toContain('echo x');
  });
});

describe('DaytonaSession file IO', () => {
  it('writeFile creates the parent directory then uploads bytes', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await session.writeFile(
      '/data/blob.bin',
      new Uint8Array([1, 2, 3]),
    );

    expect(sbx.fs.createFolder).toHaveBeenCalledWith('/data', '755');
    expect(sbx.fs.uploadFile).toHaveBeenCalledTimes(1);
    const args = sbx.fs.uploadFile.mock.calls[0];
    const buf = args?.[0] as Buffer;
    const remote = args?.[1] as string;
    expect(remote).toBe('/data/blob.bin');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });

  it('writeFile rejects empty / root paths', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await expect(
      session.writeFile('', new Uint8Array([1])),
    ).rejects.toThrow(/invalid sandbox path/);
    await expect(
      session.writeFile('/', new Uint8Array([1])),
    ).rejects.toThrow(/invalid sandbox path/);
    expect(sbx.fs.uploadFile).not.toHaveBeenCalled();
  });

  it('writeFile swallows createFolder errors but still uploads', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.fs.createFolder.mockRejectedValueOnce(new Error('already exists'));

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await session.writeFile('/data/x.bin', new Uint8Array([9]));
    expect(sbx.fs.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('readFile returns bytes from the SDK Buffer', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.fs.downloadFile.mockResolvedValue(Buffer.from('howdy'));

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    const back = await session.readFile('/etc/greeting');
    expect(new TextDecoder().decode(back)).toBe('howdy');
    expect(sbx.fs.downloadFile).toHaveBeenCalledWith('/etc/greeting');
  });

  it('readFile maps DaytonaNotFoundError to SandboxFileNotFoundError', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.fs.downloadFile.mockRejectedValue(
      new hoisted.MockDaytonaNotFoundError('not found'),
    );

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await expect(session.readFile('/no/such/file')).rejects.toBeInstanceOf(
      SandboxFileNotFoundError,
    );
  });

  it('uploadFile reads the host file and writes via writeFile semantics', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    const provider = new DaytonaProvider();
    const session = await provider.create({});

    // Stage a real file on disk so we exercise nodeFs.readFile.
    const { promises: fs } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-unit-'));
    const hostFile = path.join(tmpDir, 'creds.json');
    await fs.writeFile(hostFile, '{"token":"abc"}', 'utf8');
    try {
      await session.uploadFile(hostFile, '/root/.claude/creds.json');
      expect(sbx.fs.createFolder).toHaveBeenCalledWith(
        '/root/.claude',
        '755',
      );
      const args = sbx.fs.uploadFile.mock.calls[0];
      const buf = args?.[0] as Buffer;
      expect(buf.toString('utf8')).toBe('{"token":"abc"}');
      expect(args?.[1]).toBe('/root/.claude/creds.json');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('DaytonaSession.startStream()', () => {
  it('synthesizes events for stream-lines without hitting the SDK', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    const provider = new DaytonaProvider();
    const session = await provider.create({});
    const out: unknown[] = [];
    for await (const ev of session.startStream(['stream-lines', 'a', 'b'])) {
      out.push(ev);
    }
    expect(out).toEqual([
      { kind: 'stdout', data: 'a\n' },
      { kind: 'stdout', data: 'b\n' },
      { kind: 'exit', code: 0 },
    ]);
    expect(sbx.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it('falls back to a single run() emit + exit for non-stream-lines argv', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'hi\n',
      stderr: '',
      output: 'hi\n',
    });

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    const events: unknown[] = [];
    for await (const ev of session.startStream(['echo', 'hi'])) {
      events.push(ev);
    }
    expect(events).toEqual([
      { kind: 'stdout', data: 'hi\n' },
      { kind: 'exit', code: 0 },
    ]);
  });

  it('consumer can break early and the session stays usable', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'still-alive\n',
      stderr: '',
      output: 'still-alive\n',
    });
    const provider = new DaytonaProvider();
    const session = await provider.create({});

    let seen = 0;
    for await (const ev of session.startStream([
      'stream-lines',
      'a',
      'b',
      'c',
    ])) {
      void ev;
      seen += 1;
      if (seen >= 2) break;
    }
    expect(seen).toBe(2);
    const r = await session.run(['echo', 'still-alive']);
    expect(r.exit_code).toBe(0);
  });
});

describe('DaytonaSession.destroy()', () => {
  it('deletes the run session and the sandbox, then becomes idempotent', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    });

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    // Force a run() so the run session is created and torn down too.
    await session.run(['true']);

    await session.destroy();
    expect(sbx.process.deleteSession).toHaveBeenCalledWith('auto-finish-run');
    expect(mockClient.delete).toHaveBeenCalledWith(sbx);

    // Idempotent
    await expect(session.destroy()).resolves.toBeUndefined();
    expect(mockClient.delete).toHaveBeenCalledTimes(1);
  });

  it('makes subsequent operations throw SandboxDestroyedError', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await session.destroy();
    await expect(session.run(['echo', 'x'])).rejects.toBeInstanceOf(
      SandboxDestroyedError,
    );
    await expect(session.readFile('/x')).rejects.toBeInstanceOf(
      SandboxDestroyedError,
    );
    await expect(
      session.writeFile('/x', new Uint8Array([1])),
    ).rejects.toBeInstanceOf(SandboxDestroyedError);
  });

  it('swallows SDK errors during teardown', async () => {
    const sbx = makeMockSandbox();
    mockClient.create.mockResolvedValue(sbx);
    sbx.process.executeSessionCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      output: '',
    });
    sbx.process.deleteSession.mockRejectedValue(new Error('gone'));
    mockClient.delete.mockRejectedValue(new Error('gone'));

    const provider = new DaytonaProvider();
    const session = await provider.create({});
    await session.run(['true']);
    await expect(session.destroy()).resolves.toBeUndefined();
  });
});
