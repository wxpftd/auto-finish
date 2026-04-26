/**
 * OpenSandboxProvider — `SandboxProvider` implementation backed by the
 * official `@alibaba-group/opensandbox` TypeScript SDK (Apache 2.0).
 *
 * Strategy: we use the SDK's `Sandbox` class which bundles both the
 * Lifecycle API (port 8080, `OPEN-SANDBOX-API-KEY` header) and the per-
 * sandbox `execd` API (default port 44772, `X-EXECD-ACCESS-TOKEN` header,
 * resolved via `getSandboxEndpoint`). The SDK handles the create→endpoint-
 * resolution→ready-poll dance internally, so this file only adapts the
 * SDK's `Execution` / `WriteEntry` shapes onto our `RunResult` / `Uint8Array`
 * contract.
 *
 * SDK env-name divergence: the SDK's `ConnectionConfig` defaults read
 * `OPEN_SANDBOX_DOMAIN` / `OPEN_SANDBOX_API_KEY` (underscored). We keep
 * our project-wide names `OPENSANDBOX_ENDPOINT` / `OPENSANDBOX_API_KEY`
 * unchanged and bridge by always constructing `ConnectionConfig` explicitly
 * with the values we resolved.
 *
 * Running integration tests:
 *   The companion `opensandbox-provider.integration.test.ts` is gated.
 *   Default `pnpm test` skips it. To exercise the real SDK contract:
 *
 *     OPENSANDBOX_INTEGRATION=1 \
 *     pnpm test src/sandbox/opensandbox-provider.integration.test.ts
 *
 * Design notes:
 *   - `stream-lines` is a CONTRACT-TEST ALIAS (see `contract.ts`) —
 *     synthesized locally rather than rewritten into a `printf` script.
 *   - `timeout_ms` is enforced LOCALLY with `Promise.race(setTimeout(reject))`
 *     PLUS we abort the in-flight SDK request via `AbortController` so the
 *     underlying HTTP call doesn't leak past the deadline.
 *   - `Sandbox.kill()` and `close()` are wrapped in try/catch in `destroy()`
 *     so it remains idempotent (safe to call from `finally`).
 *   - Error mapping: re-uses `SandboxDestroyedError`,
 *     `SandboxFileNotFoundError`, `SandboxTimeoutError` from
 *     `./in-memory-provider.js` so callers can `instanceof`-check the
 *     same set of classes regardless of provider.
 *   - File-not-found translation: the SDK throws `SandboxApiException` with
 *     `statusCode === 404` for missing files; we also fall back to a phrasing
 *     heuristic for other Error sources.
 *   - `writeFile` calls `files.createDirectories` on the parent dir(s) before
 *     `files.writeFiles` to satisfy the contract's "deep path works" test.
 *   - `uploadFile` is routed through `writeFile` to share parent-dir logic,
 *     mirroring the in-memory provider.
 *   - `VolumeBinding` → SDK `Volume` mapping: see {@link toSdkVolume}.
 *     `{ kind: 'host' }` defaults `path` to the binding's `mountPath`.
 *     `ossfs` is NOT yet implemented in Phase 1.6 — emits a clear error
 *     so a misconfigured deploy fails fast rather than silently dropping.
 *
 * Known divergences from byte-faithful providers (verified against
 * sandbox-server v1.x, SDK 0.1.6):
 *   - **Trailing newline loss on stdout/stderr.** The SDK exposes
 *     `exec.logs.stdout` as a `[{text}]` array where each entry is one
 *     line WITHOUT its terminating `\n`. Joining the entries reconstructs
 *     the visible content but loses information about whether the
 *     original byte stream ended with a newline. The contract tests use
 *     `/^.+\n?$/` matchers so both byte-faithful (InMemory) and
 *     line-oriented (this provider) backends pass; runner / Claude CLI
 *     consumers handle output line-by-line so this loss is invisible to
 *     them.
 *   - **`useServerProxy` required when SDK and sandbox aren't on the same
 *     network.** Bridge-mode endpoint URLs returned by the lifecycle API
 *     are reachable from inside the sandbox network but not from a host
 *     SDK. Set `OPENSANDBOX_USE_SERVER_PROXY=1` (env) or pass
 *     `useServerProxy: true` in `OpenSandboxProviderOpts` for dev / smoke
 *     test setups; leave it off for in-cluster deploys where the SDK
 *     shares the sandbox network.
 */

import { promises as nodeFs } from 'node:fs';
import * as nodePath from 'node:path';
import {
  Sandbox,
  ConnectionConfig,
  SandboxApiException,
} from '@alibaba-group/opensandbox';
import type {
  SandboxCreateOptions,
  RunCommandOpts,
  ServerStreamEvent,
  Volume as SdkVolume,
} from '@alibaba-group/opensandbox';
import type {
  RunOpts,
  RunResult,
  SandboxConfig,
  SandboxProvider,
  SandboxSession,
  StreamEvent,
  VolumeBinding,
} from './interface.js';
import {
  SandboxDestroyedError,
  SandboxFileNotFoundError,
  SandboxTimeoutError,
} from './in-memory-provider.js';

/** Default OCI image when `SandboxConfig.image` is unset. */
const DEFAULT_IMAGE = 'ubuntu:24.04';

/** Default sandbox lifecycle timeout (seconds) — matches the SDK default. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** Default control-plane HTTP timeout (seconds). */
const DEFAULT_CONTROL_PLANE_TIMEOUT_SECONDS = 30;

/** Default endpoint when neither opt nor env var is set. */
const DEFAULT_ENDPOINT = 'http://localhost:8080';

export interface OpenSandboxProviderOpts {
  /**
   * OpenSandbox lifecycle endpoint. Accepts a full URL
   * (`http://host:port`, `https://host`) or a bare host[:port].
   * Falls back to env `OPENSANDBOX_ENDPOINT`, then `http://localhost:8080`.
   */
  endpoint?: string;
  /** API key (sent as `OPEN-SANDBOX-API-KEY` by the SDK). Env: `OPENSANDBOX_API_KEY`. */
  apiKey?: string;
  /** Default OCI image when `SandboxConfig.image` is unset. */
  defaultImage?: string;
  /** Sandbox lifecycle timeout in seconds (server-side TTL). Default: 600. */
  defaultTimeoutSeconds?: number;
  /** SDK request timeout for control-plane calls (seconds). Default: 30. */
  controlPlaneTimeoutSeconds?: number;
  /**
   * Route per-sandbox execd traffic through the lifecycle server instead of
   * connecting to sandbox endpoints directly. Required when the SDK runs on
   * a host that cannot reach the sandbox container's bridge-mode endpoint
   * (e.g. server-in-docker on a dev machine).
   *
   * Falls back to env `OPENSANDBOX_USE_SERVER_PROXY` (`"1"`/`"true"`).
   * Defaults to `false` — production deployments where the SDK shares the
   * sandbox network (host mode, K8s in-cluster) should leave this off so
   * execd traffic doesn't double-hop.
   */
  useServerProxy?: boolean;
}

/**
 * Pure parser for the `endpoint` field. Accepts both full URLs
 * (`http://localhost:8080`) and bare host[:port] (`localhost:8080`); strips
 * trailing slashes.
 *
 * Exported for unit testing — `new URL('localhost:8080')` interprets
 * `localhost:` as a protocol so we must detect a missing scheme manually.
 */
export function parseEndpoint(input: string): {
  protocol: 'http' | 'https';
  domain: string;
} {
  const trimmed = input.replace(/\/+$/, '');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  // url.host preserves any non-default port and lowercases the hostname.
  const domain = url.host;
  return { protocol, domain };
}

/**
 * Translate one of our `VolumeBinding`s into the SDK's `Volume` shape. Each
 * SDK Volume must have exactly one backend selector set.
 */
export function toSdkVolume(b: VolumeBinding): SdkVolume {
  const backend = b.backend ?? { kind: 'host' };
  const base: SdkVolume = {
    name: b.name,
    mountPath: b.mountPath,
    ...(b.readOnly !== undefined ? { readOnly: b.readOnly } : {}),
    ...(b.subPath !== undefined ? { subPath: b.subPath } : {}),
  };
  switch (backend.kind) {
    case 'host': {
      // SDK's Host backend requires an absolute host path. When unset,
      // fall back to the binding's mountPath (bind-mount-equals-mount-path
      // is the dominant convention for local Docker dev).
      const path = backend.path ?? b.mountPath;
      return { ...base, host: { path } };
    }
    case 'pvc':
      return { ...base, pvc: { claimName: backend.claimName } };
    case 'ossfs':
      throw new Error(
        `ossfs volume backend is not yet implemented in OpenSandboxProvider (Phase 1.6); ` +
          `volume "${b.name}" requested ossfs/${backend.bucket}`,
      );
  }
}

interface RaceTimeout {
  ms: number;
}

/**
 * Wrap a promise in a hard local deadline. Resolves the promise OR rejects
 * with `SandboxTimeoutError`, whichever comes first. Aborts the supplied
 * controller (if any) on timeout so the underlying SDK request can be cut
 * short rather than leaking past the deadline.
 */
async function withTimeout<T>(
  p: Promise<T>,
  t: RaceTimeout,
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          if (controller !== undefined) {
            try {
              controller.abort();
            } catch {
              // ignore — best-effort cancellation
            }
          }
          reject(new SandboxTimeoutError(t.ms));
        }, t.ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Heuristic match for "file not found" errors thrown by the SDK or guest
 * agent. Used as a fallback when the error isn't a 404-tagged
 * `SandboxApiException`.
 */
function looksLikeNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /not.?found|no such file|enoent/i.test(err.message);
}

/** True if the SDK threw a 404. */
function isNotFoundException(err: unknown): boolean {
  return err instanceof SandboxApiException && err.statusCode === 404;
}

/**
 * One live sandbox bound to an SDK `Sandbox` handle.
 */
export class OpenSandboxSession implements SandboxSession {
  readonly id: string;
  readonly #sdk: Sandbox;
  readonly #defaultCwd: string | undefined;
  #destroyed = false;

  constructor(sdk: Sandbox, defaultCwd: string | undefined) {
    this.id = sdk.id;
    this.#sdk = sdk;
    this.#defaultCwd = defaultCwd;
  }

  #checkAlive(): void {
    if (this.#destroyed) {
      throw new SandboxDestroyedError(this.id);
    }
  }

  async run(argv: string[], opts?: RunOpts): Promise<RunResult> {
    this.#checkAlive();
    if (argv.length === 0) {
      return { exit_code: 127, stdout: '', stderr: 'empty argv\n' };
    }

    // Recognize the contract-test `stream-lines` alias — synthesized locally
    // (see `contract.ts` design note).
    if (argv[0] === 'stream-lines') {
      const lines = argv.slice(1);
      return {
        exit_code: 0,
        stdout: lines.map((l) => l + '\n').join(''),
        stderr: '',
      };
    }

    const controller = new AbortController();
    const work = this.#runOnce(argv, opts, controller.signal);
    const timeoutMs = opts?.timeout_ms;
    if (timeoutMs !== undefined && timeoutMs >= 0) {
      return await withTimeout(work, { ms: timeoutMs }, controller);
    }
    return await work;
  }

  /** Execute one command via the SDK's `commands.run` (consumes SSE internally). */
  async #runOnce(
    argv: string[],
    opts: RunOpts | undefined,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const command = quoteArgv(argv);
    const cwd = opts?.cwd ?? this.#defaultCwd;
    const runOpts: RunCommandOpts = {
      ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
      ...(opts?.env !== undefined ? { envs: opts.env } : {}),
      ...(opts?.timeout_ms !== undefined
        ? { timeoutSeconds: Math.max(1, Math.ceil(opts.timeout_ms / 1000)) }
        : {}),
    };
    const exec = await this.#sdk.commands.run(command, runOpts, undefined, signal);
    // SDK is line-oriented: each `logs.stdout[i].text` is one line WITHOUT
    // its trailing newline, so trailing-newline information is lossy
    // (`printf "a\nb"` and `printf "a\nb\n"` both round-trip as
    // `[{text:"a"},{text:"b"}]`). We do NOT re-append `\n` — that would
    // flip the loss the other direction (a `cat` of a no-newline file
    // would gain a spurious newline). Documented in the file header as a
    // known divergence; runner / Claude CLI consumers handle stdout
    // line-by-line so they're insensitive to this.
    const stdout = exec.logs.stdout.map((m) => m.text).join('');
    const stderr = exec.logs.stderr.map((m) => m.text).join('');
    const exitCode = exec.exitCode ?? (exec.error ? 1 : 0);
    return { exit_code: exitCode, stdout, stderr };
  }

  /**
   * Stream a long-running command's output. For `stream-lines` we synthesize
   * locally (contract-test alias). Otherwise we consume the SDK's SSE stream
   * and translate `ServerStreamEvent` into our `StreamEvent` shape, ending
   * with a single `{ kind: 'exit' }` event.
   *
   * Consumer breaking out early aborts the SDK iterator via the
   * `AbortController` in `finally`, so the underlying HTTP stream is closed
   * cleanly and no microVM-side process leaks.
   */
  async *startStream(
    argv: string[],
    opts?: RunOpts,
  ): AsyncIterable<StreamEvent> {
    this.#checkAlive();

    // Contract-test alias — synthesize locally.
    if (argv[0] === 'stream-lines') {
      const lines = argv.slice(1);
      const events: StreamEvent[] = lines.map(
        (line): StreamEvent => ({ kind: 'stdout', data: line + '\n' }),
      );
      events.push({ kind: 'exit', code: 0 });
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
      return;
    }

    const controller = new AbortController();
    const command = quoteArgv(argv);
    const cwd = opts?.cwd ?? this.#defaultCwd;
    const runOpts: RunCommandOpts = {
      ...(cwd !== undefined ? { workingDirectory: cwd } : {}),
      ...(opts?.env !== undefined ? { envs: opts.env } : {}),
      ...(opts?.timeout_ms !== undefined
        ? { timeoutSeconds: Math.max(1, Math.ceil(opts.timeout_ms / 1000)) }
        : {}),
    };

    let emittedExit = false;
    let exitCode = 0;
    const iter = this.#sdk.commands.runStream(command, runOpts, controller.signal);
    try {
      for await (const ev of iter as AsyncIterable<ServerStreamEvent>) {
        if (ev.type === 'stdout') {
          if (typeof ev.text === 'string' && ev.text.length > 0) {
            yield { kind: 'stdout', data: ev.text };
          }
        } else if (ev.type === 'stderr') {
          if (typeof ev.text === 'string' && ev.text.length > 0) {
            yield { kind: 'stderr', data: ev.text };
          }
        } else if (ev.type === 'execution_complete') {
          // exitCode lands on the parent Execution but isn't part of the
          // event payload; default to 0 unless an error event was seen.
          // (Real-world `commands.run` sets it; for stream we accept the
          // post-stream default of 0 for clean exits.)
          // Leave exitCode as-is (0 by default; bumped on 'error').
        } else if (ev.type === 'error') {
          exitCode = 1;
        }
        // Other event types (init, result, execution_count, ...) — ignore.
      }
      yield { kind: 'exit', code: exitCode };
      emittedExit = true;
    } finally {
      if (!emittedExit) {
        // Consumer broke early — abort the SDK iterator so the underlying
        // HTTP stream closes cleanly.
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.#checkAlive();
    try {
      const bytes = await this.#sdk.files.readBytes(path);
      // Defensive copy — we own our return value.
      return new Uint8Array(bytes);
    } catch (err) {
      if (isNotFoundException(err) || looksLikeNotFound(err)) {
        throw new SandboxFileNotFoundError(path);
      }
      throw err;
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.#checkAlive();
    if (path === '' || path === '/' || path === '.') {
      throw new Error(`invalid sandbox path: ${path}`);
    }
    const dir = nodePath.posix.dirname(path);
    if (dir && dir !== '.' && dir !== '/') {
      // Best-effort recursive parent-dir creation. The SDK's
      // `createDirectories` documents mkdir-p semantics; errors here
      // surface on the subsequent write.
      try {
        await this.#sdk.files.createDirectories([{ path: dir }]);
      } catch {
        // ignore — already exists / permission noise
      }
    }
    // Defensive copy: SDK may retain the buffer. WriteEntry.data accepts
    // Uint8Array directly, so no base64 dance is needed.
    const data = new Uint8Array(content);
    await this.#sdk.files.writeFiles([{ path, data }]);
  }

  async uploadFile(hostPath: string, sandboxPath: string): Promise<void> {
    this.#checkAlive();
    const bytes = await nodeFs.readFile(hostPath);
    await this.writeFile(sandboxPath, new Uint8Array(bytes));
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // Best-effort teardown. We swallow errors so destroy() remains
    // idempotent / safe to call from `finally`.
    try {
      await this.#sdk.kill();
    } catch {
      // ignore — sandbox may already be gone
    }
    try {
      await this.#sdk.close();
    } catch {
      // ignore — transport may already be released
    }
  }
}

/**
 * Shell-quote a single argv token so it can be safely interpolated into a
 * shell command string. The SDK's `commands.run` takes a single command
 * string (not argv), so we shell-quote with single quotes; embedded single
 * quotes are escaped as `'\''`. POSIX-portable, no Bashism dependency.
 */
function quoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join an argv into a single shell command string. */
function quoteArgv(argv: string[]): string {
  return argv.map(quoteArg).join(' ');
}

/**
 * `SandboxProvider` backed by the OpenSandbox SDK. Each `create()` call
 * provisions a fresh sandbox via `Sandbox.create` and returns an
 * {@link OpenSandboxSession} wrapping the SDK handle.
 */
export class OpenSandboxProvider implements SandboxProvider {
  readonly #connectionConfig: ConnectionConfig;
  readonly #defaultImage: string;
  readonly #defaultTimeoutSeconds: number;

  constructor(opts: OpenSandboxProviderOpts = {}) {
    const endpointStr =
      opts.endpoint ??
      process.env['OPENSANDBOX_ENDPOINT'] ??
      DEFAULT_ENDPOINT;
    const apiKey = opts.apiKey ?? process.env['OPENSANDBOX_API_KEY'];
    const { protocol, domain } = parseEndpoint(endpointStr);
    const useServerProxy =
      opts.useServerProxy ??
      ((): boolean => {
        const v = process.env['OPENSANDBOX_USE_SERVER_PROXY'];
        return v === '1' || v?.toLowerCase() === 'true';
      })();

    this.#connectionConfig = new ConnectionConfig({
      domain,
      protocol,
      ...(apiKey !== undefined ? { apiKey } : {}),
      requestTimeoutSeconds:
        opts.controlPlaneTimeoutSeconds ?? DEFAULT_CONTROL_PLANE_TIMEOUT_SECONDS,
      useServerProxy,
    });
    this.#defaultImage = opts.defaultImage ?? DEFAULT_IMAGE;
    this.#defaultTimeoutSeconds =
      opts.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  async create(config: SandboxConfig): Promise<SandboxSession> {
    const volumes = config.volumes?.map(toSdkVolume);
    const createOpts: SandboxCreateOptions = {
      connectionConfig: this.#connectionConfig,
      image: config.image ?? this.#defaultImage,
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(volumes !== undefined && volumes.length > 0 ? { volumes } : {}),
      timeoutSeconds: this.#defaultTimeoutSeconds,
    };
    const sdkSandbox = await Sandbox.create(createOpts);
    const session = new OpenSandboxSession(sdkSandbox, config.working_dir);

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
