/**
 * Contract battery + targeted unit tests for `OpenSandboxProvider`.
 *
 * Strategy: mock `@alibaba-group/opensandbox` so `Sandbox.create` returns a
 * fake handle whose `commands.run`, `commands.runStream`, `files.*`, `kill`,
 * and `close` all delegate to an `InMemorySession`. This lets the entire
 * 11-test contract battery run locally without a real OpenSandbox server,
 * while still exercising every adapter path in `opensandbox-provider.ts`.
 *
 * The integration test (gated, skipped in CI) covers the real SDK against a
 * real server. Here we verify our adapter logic in isolation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryProvider,
  SandboxFileNotFoundError,
} from './in-memory-provider.js';
import type { SandboxSession } from './interface.js';

// ─── Mock the SDK ───────────────────────────────────────────────────────────

// Each FakeSandbox owns one InMemorySession. We expose a small registry on
// `globalThis` so tests can toggle "next call should fail with 404" behaviour
// when needed (used by the not-found translation unit test).
interface SdkTestHooks {
  forceReadFileNotFound: boolean;
  forceReadFileGenericError: boolean;
}
const hooks: SdkTestHooks = {
  forceReadFileNotFound: false,
  forceReadFileGenericError: false,
};

vi.mock('@alibaba-group/opensandbox', async () => {
  const memMod = await import('./in-memory-provider.js');
  const inMem = new memMod.InMemoryProvider();

  class ConnectionConfig {
    constructor(_opts?: unknown) {
      void _opts;
    }
  }

  class SandboxApiException extends Error {
    public statusCode?: number;
    constructor(opts: { message?: string; statusCode?: number } = {}) {
      super(opts.message ?? 'SandboxApiException');
      this.name = 'SandboxApiException';
      this.statusCode = opts.statusCode;
    }
  }

  /** Tokenize a quoted shell-command string back into argv. */
  function parseCommand(cmd: string): string[] {
    const out: string[] = [];
    let i = 0;
    let cur = '';
    let inSingle = false;
    while (i < cmd.length) {
      const c = cmd[i]!;
      if (inSingle) {
        if (c === "'") {
          // POSIX single quotes: '\'' escapes a literal single quote.
          if (cmd.slice(i, i + 4) === `'\\''`) {
            cur += "'";
            i += 4;
            continue;
          }
          inSingle = false;
          i += 1;
          continue;
        }
        cur += c;
        i += 1;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        i += 1;
        continue;
      }
      if (c === ' ') {
        if (cur.length > 0 || cmd[i - 1] === "'") {
          out.push(cur);
          cur = '';
        }
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
    }
    if (cur.length > 0 || cmd.endsWith("''")) {
      out.push(cur);
    }
    return out;
  }

  class FakeSandbox {
    readonly id: string;
    readonly #session: SandboxSession;
    #closed = false;

    constructor(id: string, session: SandboxSession) {
      this.id = id;
      this.#session = session;
    }

    static async create(opts: {
      image?: unknown;
      env?: Record<string, string>;
      volumes?: unknown;
    }): Promise<FakeSandbox> {
      const session = await inMem.create({
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
      return new FakeSandbox(session.id, session);
    }

    get commands() {
      const session = this.#session;
      return {
        run: async (
          cmd: string,
          options?: {
            workingDirectory?: string;
            envs?: Record<string, string>;
            timeoutSeconds?: number;
          },
          _handlers?: unknown,
          signal?: AbortSignal,
        ) => {
          void _handlers;
          const argv = parseCommand(cmd);
          // Map SDK opts onto our RunOpts. We don't honor timeoutSeconds at
          // the SDK layer here — the provider's outer `withTimeout` covers
          // the contract's hard-deadline test.
          const opts: { cwd?: string; env?: Record<string, string> } = {};
          if (options?.workingDirectory) opts.cwd = options.workingDirectory;
          if (options?.envs) opts.env = options.envs;

          // Honor signal: if aborted, reject early.
          if (signal?.aborted) {
            throw new Error('aborted');
          }
          const r = await session.run(argv, opts);
          return {
            logs: {
              stdout: r.stdout
                ? [{ text: r.stdout, timestamp: Date.now() }]
                : [],
              stderr: r.stderr
                ? [{ text: r.stderr, timestamp: Date.now() }]
                : [],
            },
            result: [],
            exitCode: r.exit_code,
          };
        },
        runStream: (
          cmd: string,
          options?: {
            workingDirectory?: string;
            envs?: Record<string, string>;
            timeoutSeconds?: number;
          },
          signal?: AbortSignal,
        ): AsyncIterable<{ type: string; text?: string }> => {
          const argv = parseCommand(cmd);
          const opts: { cwd?: string; env?: Record<string, string> } = {};
          if (options?.workingDirectory) opts.cwd = options.workingDirectory;
          if (options?.envs) opts.env = options.envs;
          const inner = session.startStream(argv, opts);
          return (async function* () {
            for await (const ev of inner) {
              if (signal?.aborted) return;
              if (ev.kind === 'stdout') {
                yield { type: 'stdout', text: ev.data };
              } else if (ev.kind === 'stderr') {
                yield { type: 'stderr', text: ev.data };
              } else if (ev.kind === 'exit') {
                // SDK signals completion via a separate event without
                // exit code on the payload; the adapter post-stream
                // assumes 0 unless an `error` event was seen. To mirror
                // that for the contract test we intentionally do NOT
                // forward the inner exit code, so the adapter's default-0
                // path is exercised.
                yield { type: 'execution_complete' };
              }
            }
          })();
        },
        interrupt: async () => undefined,
        getCommandStatus: async () => ({}),
      };
    }

    get files() {
      const session = this.#session;
      return {
        readBytes: async (path: string): Promise<Uint8Array> => {
          if (hooks.forceReadFileNotFound) {
            throw new SandboxApiException({
              message: 'not found',
              statusCode: 404,
            });
          }
          if (hooks.forceReadFileGenericError) {
            throw new Error('generic: no such file or directory');
          }
          try {
            return await session.readFile(path);
          } catch (err) {
            if (err instanceof memMod.SandboxFileNotFoundError) {
              throw new SandboxApiException({
                message: 'not found',
                statusCode: 404,
              });
            }
            throw err;
          }
        },
        writeFiles: async (
          entries: Array<{ path: string; data?: Uint8Array | string }>,
        ): Promise<void> => {
          for (const e of entries) {
            const data = e.data;
            const bytes =
              data instanceof Uint8Array
                ? data
                : typeof data === 'string'
                  ? new TextEncoder().encode(data)
                  : new Uint8Array();
            await session.writeFile(e.path, bytes);
          }
        },
        createDirectories: async (
          _entries: Array<{ path: string }>,
        ): Promise<void> => {
          // InMemoryProvider doesn't track dirs separately — no-op.
          void _entries;
        },
        deleteFiles: async () => undefined,
        getFileInfo: async () => ({}),
      };
    }

    async kill(): Promise<void> {
      if (this.#closed) return;
      this.#closed = true;
      await this.#session.destroy();
    }

    async close(): Promise<void> {
      // No-op; transport teardown not modeled.
    }
  }

  return {
    Sandbox: FakeSandbox,
    ConnectionConfig,
    SandboxApiException,
  };
});

import { OpenSandboxProvider } from './opensandbox-provider.js';
import { runProviderContract } from './contract.js';

// ─── Contract battery ───────────────────────────────────────────────────────

runProviderContract('OpenSandboxProvider', () => new OpenSandboxProvider());

// ─── Targeted unit tests ────────────────────────────────────────────────────

describe('OpenSandboxProvider unit', () => {
  it('destroy() is idempotent across many calls', async () => {
    const provider = new OpenSandboxProvider();
    const session = await provider.create({});
    await session.destroy();
    await session.destroy();
    await session.destroy();
    // Subsequent operations must throw.
    await expect(session.run(['echo', 'x'])).rejects.toThrow(/destroyed/i);
  });

  it('stream-lines alias is intercepted before reaching the SDK', async () => {
    const provider = new OpenSandboxProvider();
    const session = await provider.create({});
    try {
      // Synthetic stream-lines should produce one stdout per line plus exit.
      const events: Array<{ kind: string }> = [];
      for await (const ev of session.startStream([
        'stream-lines',
        'a',
        'b',
      ])) {
        events.push(ev);
      }
      expect(events.map((e) => e.kind)).toEqual(['stdout', 'stdout', 'exit']);
    } finally {
      await session.destroy();
    }
  });

  it('readFile translates SDK 404 into SandboxFileNotFoundError', async () => {
    const provider = new OpenSandboxProvider();
    const session = await provider.create({});
    hooks.forceReadFileNotFound = true;
    try {
      await expect(session.readFile('/nope')).rejects.toBeInstanceOf(
        SandboxFileNotFoundError,
      );
    } finally {
      hooks.forceReadFileNotFound = false;
      await session.destroy();
    }
  });

  it('readFile translates "no such file" prose into SandboxFileNotFoundError', async () => {
    const provider = new OpenSandboxProvider();
    const session = await provider.create({});
    hooks.forceReadFileGenericError = true;
    try {
      await expect(session.readFile('/nope')).rejects.toBeInstanceOf(
        SandboxFileNotFoundError,
      );
    } finally {
      hooks.forceReadFileGenericError = false;
      await session.destroy();
    }
  });

  // `setup_commands` is no longer a SandboxConfig field — the runner drives
  // them post-clone (see runner/runner.ts). Provider-level setup-failure
  // semantics are now exercised by runner-level tests.
});

// Use InMemoryProvider import to keep this in the import graph for the mock factory.
void InMemoryProvider;
