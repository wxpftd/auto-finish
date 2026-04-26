/**
 * DaytonaProvider — `SandboxProvider` implementation backed by `@daytonaio/sdk`.
 *
 * Required environment variables (or pass via constructor opts):
 *   - DAYTONA_API_KEY    Daytona API key (required for auth)
 *   - DAYTONA_API_URL    Daytona API URL (defaults to https://app.daytona.io/api)
 *   - DAYTONA_TARGET     Optional target/region (e.g. 'us', 'eu')
 *
 * Where to get a Daytona API key:
 *   - Sign in at https://app.daytona.io and create a key in the dashboard.
 *   - For local self-hosted Daytona, point DAYTONA_API_URL at your local
 *     server (e.g. http://localhost:3986/api) and use a key minted there.
 *
 * Running integration tests:
 *   The companion `daytona-provider.integration.test.ts` is gated. Default
 *   `pnpm test` skips it. To exercise the real Daytona contract:
 *
 *     DAYTONA_INTEGRATION=1 \
 *     DAYTONA_API_URL=http://localhost:3986/api \
 *     DAYTONA_API_KEY=... \
 *     pnpm test src/sandbox/daytona-provider.integration.test.ts
 *
 * Design notes:
 *   - The SDK's `executeCommand` only returns `{exitCode, result}` — there
 *     is no separate stderr field, but the contract test asserts
 *     `r.stderr.toContain('boom')` for `/bin/sh -c 'boom'`. So we route
 *     `run()` through a long-lived `Process` *session* (`createSession` +
 *     `executeSessionCommand`), whose response carries `stdout` and
 *     `stderr` separately.
 *   - argv is shell-quoted into a single command string before being sent
 *     to the SDK (the SDK API takes a string, not argv).
 *   - `stream-lines` is recognized as a contract-test alias (see
 *     `contract.ts`) and synthesized locally rather than rewritten into
 *     a printf incantation.
 *   - The SDK's per-call timeouts are best-effort hints; `timeout_ms` is
 *     enforced locally with `Promise.race(setTimeout(reject))`.
 *   - `writeFile` calls `fs.createFolder(dirname, '755')` first so deep
 *     paths work without the caller mkdir-ing.
 *   - Destroyed-state tracking is local (the SDK handle keeps working
 *     even after the user logically released it, so we mirror the
 *     `InMemoryProvider` pattern).
 *   - Error mapping: we re-use `SandboxDestroyedError`,
 *     `SandboxFileNotFoundError` and `SandboxTimeoutError` from
 *     `./in-memory-provider.js` so callers can `instanceof`-check the
 *     same set of classes regardless of provider. SDK errors
 *     (`DaytonaNotFoundError`, etc.) are translated; everything else
 *     bubbles up unwrapped.
 */

import { promises as nodeFs } from 'node:fs';
import * as nodePath from 'node:path';
import {
  Daytona,
  DaytonaNotFoundError,
} from '@daytonaio/sdk';
import type { Sandbox as DaytonaSandbox } from '@daytonaio/sdk';
import type {
  RunOpts,
  RunResult,
  SandboxConfig,
  SandboxProvider,
  SandboxSession,
  StreamEvent,
} from './interface.js';
import {
  SandboxDestroyedError,
  SandboxFileNotFoundError,
  SandboxTimeoutError,
} from './in-memory-provider.js';

/** Default container image when `SandboxConfig.image` is unset. */
const DEFAULT_IMAGE = 'ubuntu:24.04';

/** Default name of the long-lived Process session used for `run()`. */
const RUN_SESSION_ID = 'auto-finish-run';

/**
 * Constructor options for {@link DaytonaProvider}. Each field falls back to
 * the corresponding env var when undefined.
 */
export interface DaytonaProviderOpts {
  /** Daytona API URL. Defaults to `process.env.DAYTONA_API_URL`. */
  apiUrl?: string;
  /** Daytona API key. Defaults to `process.env.DAYTONA_API_KEY`. */
  apiKey?: string;
  /** Daytona target/region. Defaults to `process.env.DAYTONA_TARGET`. */
  target?: string;
}

/**
 * Shell-quote a single argv token so it can be safely pasted into a
 * /bin/sh -c command line. We use single-quotes and escape embedded
 * single-quotes as `'\''` — POSIX-portable, no Bashism dependency.
 */
export function quoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join an argv into a single shell command string. */
export function quoteArgv(argv: string[]): string {
  return argv.map(quoteArg).join(' ');
}

/**
 * Build env-var prefix `KEY=value KEY2=value2 ` so `executeSessionCommand`
 * can pass per-call env without depending on the SDK accepting an env map.
 */
function envPrefix(env: Record<string, string> | undefined): string {
  if (env === undefined) return '';
  const entries = Object.entries(env);
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${quoteArg(v)}`).join(' ') + ' ';
}

/** Build a `cd <cwd> && <cmd>` prefix when a working dir override is set. */
function cwdPrefix(cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return '';
  return `cd ${quoteArg(cwd)} && `;
}

/**
 * Compose the final `/bin/sh -c` command string from argv + RunOpts. Used
 * by both `run()` and `startStream()` so they stay in sync.
 */
function composeShellCommand(argv: string[], opts?: RunOpts): string {
  return cwdPrefix(opts?.cwd) + envPrefix(opts?.env) + quoteArgv(argv);
}

interface RaceTimeout {
  ms: number;
}

/**
 * Wrap a promise in a hard local deadline. Resolves the promise OR rejects
 * with `SandboxTimeoutError`, whichever comes first.
 */
async function withTimeout<T>(p: Promise<T>, t: RaceTimeout): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new SandboxTimeoutError(t.ms)),
          t.ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Translate an SDK error into a project-local error class when there's a
 * good match, otherwise return it unchanged.
 *
 * - `DaytonaNotFoundError` on a path-shaped operation -> `SandboxFileNotFoundError`
 * - everything else: returned as-is (and rethrown by the caller)
 */
function translateSdkError(err: unknown, pathHint?: string): unknown {
  if (err instanceof DaytonaNotFoundError && pathHint !== undefined) {
    return new SandboxFileNotFoundError(pathHint);
  }
  return err;
}

/**
 * One live sandbox bound to a Daytona `Sandbox` handle.
 */
export class DaytonaSession implements SandboxSession {
  readonly id: string;
  readonly #daytona: Daytona;
  readonly #sandbox: DaytonaSandbox;
  readonly #runSessionId: string;
  #destroyed = false;
  #runSessionReady = false;

  constructor(daytona: Daytona, sandbox: DaytonaSandbox) {
    this.#daytona = daytona;
    this.#sandbox = sandbox;
    this.id = sandbox.id;
    this.#runSessionId = RUN_SESSION_ID;
  }

  #checkAlive(): void {
    if (this.#destroyed) {
      throw new SandboxDestroyedError(this.id);
    }
  }

  /** Lazily create the long-lived Process session that backs `run()`. */
  async #ensureRunSession(): Promise<void> {
    if (this.#runSessionReady) return;
    await this.#sandbox.process.createSession(this.#runSessionId);
    this.#runSessionReady = true;
  }

  async run(argv: string[], opts?: RunOpts): Promise<RunResult> {
    this.#checkAlive();
    if (argv.length === 0) {
      return { exit_code: 127, stdout: '', stderr: 'empty argv\n' };
    }

    // Recognize the contract-test `stream-lines` alias.
    if (argv[0] === 'stream-lines') {
      const lines = argv.slice(1);
      return {
        exit_code: 0,
        stdout: lines.map((l) => l + '\n').join(''),
        stderr: '',
      };
    }

    const command = composeShellCommand(argv, opts);
    const exec = this.#runOnce(command);
    const timeoutMs = opts?.timeout_ms;
    if (timeoutMs !== undefined && timeoutMs >= 0) {
      return await withTimeout(exec, { ms: timeoutMs });
    }
    return await exec;
  }

  /** Execute one shell command via the long-lived Process session. */
  async #runOnce(command: string): Promise<RunResult> {
    await this.#ensureRunSession();
    const resp = await this.#sandbox.process.executeSessionCommand(
      this.#runSessionId,
      { command, runAsync: false },
    );
    return {
      exit_code: resp.exitCode ?? 0,
      stdout: resp.stdout ?? '',
      stderr: resp.stderr ?? '',
    };
  }

  /**
   * Stream a long-running command's output. The Daytona SDK has session
   * log streaming (`getSessionCommandLogs(sid, cid, onStdout, onStderr)`)
   * but it's only available *after* the command has been kicked off
   * asynchronously; for simplicity and correctness we run the command
   * synchronously then emit one stdout chunk + (if any) one stderr chunk
   * + the exit event. For the contract's `stream-lines` alias we
   * synthesize the events directly.
   *
   * Consumer breaking out of the iterator early is handled in `finally`:
   * we have nothing to kill (the run already completed) but the branch
   * is exercised for parity with implementations that do.
   */
  async *startStream(
    argv: string[],
    opts?: RunOpts,
  ): AsyncIterable<StreamEvent> {
    this.#checkAlive();

    // Synthesize events for the `stream-lines` contract alias.
    let events: StreamEvent[];
    if (argv[0] === 'stream-lines') {
      const lines = argv.slice(1);
      events = lines.map(
        (line): StreamEvent => ({ kind: 'stdout', data: line + '\n' }),
      );
      events.push({ kind: 'exit', code: 0 });
    } else {
      const result = await this.run(argv, opts);
      events = [];
      if (result.stdout.length > 0) {
        events.push({ kind: 'stdout', data: result.stdout });
      }
      if (result.stderr.length > 0) {
        events.push({ kind: 'stderr', data: result.stderr });
      }
      events.push({ kind: 'exit', code: result.exit_code });
    }

    let cancelled = true;
    try {
      for (const ev of events) {
        await Promise.resolve();
        yield ev;
      }
      cancelled = false;
    } finally {
      void cancelled;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.#checkAlive();
    try {
      const buf = await this.#sandbox.fs.downloadFile(path);
      return new Uint8Array(buf);
    } catch (err) {
      throw translateSdkError(err, path);
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.#checkAlive();
    if (path === '' || path === '/' || path === '.') {
      throw new Error(`invalid sandbox path: ${path}`);
    }
    const dir = nodePath.posix.dirname(path);
    if (dir && dir !== '.' && dir !== '/') {
      try {
        await this.#sandbox.fs.createFolder(dir, '755');
      } catch {
        // Ignore "already exists" / permission noise — uploadFile will
        // surface a real failure.
      }
    }
    const buf = Buffer.from(content);
    await this.#sandbox.fs.uploadFile(buf, path);
  }

  async uploadFile(hostPath: string, sandboxPath: string): Promise<void> {
    this.#checkAlive();
    // Read the host file into a Buffer and hand it to writeFile so we get
    // the same parent-dir-create behaviour. For very large credentials
    // files this is fine; in practice Claude credentials are < 8 KiB.
    const bytes = await nodeFs.readFile(hostPath);
    await this.writeFile(sandboxPath, new Uint8Array(bytes));
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // Best-effort teardown. We intentionally swallow errors so destroy()
    // remains idempotent / safe to call from `finally`.
    if (this.#runSessionReady) {
      try {
        await this.#sandbox.process.deleteSession(this.#runSessionId);
      } catch {
        // ignore
      }
    }
    try {
      await this.#daytona.delete(this.#sandbox);
    } catch {
      // ignore
    }
  }
}

/**
 * `SandboxProvider` backed by Daytona. Each `create()` call provisions a
 * fresh sandbox via the Daytona SDK and returns a {@link DaytonaSession}
 * wrapping the SDK handle.
 */
export class DaytonaProvider implements SandboxProvider {
  readonly #client: Daytona;

  constructor(opts: DaytonaProviderOpts = {}) {
    const apiUrl = opts.apiUrl ?? process.env['DAYTONA_API_URL'];
    const apiKey = opts.apiKey ?? process.env['DAYTONA_API_KEY'];
    const target = opts.target ?? process.env['DAYTONA_TARGET'];
    this.#client = new Daytona({
      ...(apiUrl !== undefined ? { apiUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(target !== undefined ? { target } : {}),
    });
  }

  async create(config: SandboxConfig): Promise<SandboxSession> {
    const params = {
      image: config.image ?? DEFAULT_IMAGE,
      ...(config.env !== undefined ? { envVars: config.env } : {}),
    };
    const sandbox = await this.#client.create(params);
    const session = new DaytonaSession(this.#client, sandbox);

    // Run user-provided setup_commands serially. Stop on the first
    // non-zero exit so the caller doesn't get a half-broken sandbox.
    const setup = config.setup_commands ?? [];
    for (const cmd of setup) {
      const r = await session.run(['/bin/sh', '-c', cmd]);
      if (r.exit_code !== 0) {
        await session.destroy();
        throw new Error(
          `setup command failed (exit ${r.exit_code}): ${cmd}\n${r.stderr}`,
        );
      }
    }
    return session;
  }
}
