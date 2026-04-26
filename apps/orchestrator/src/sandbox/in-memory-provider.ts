/**
 * Reference, in-memory implementation of SandboxProvider.
 *
 * For tests only. It is NOT a real shell — it recognizes a small fixed set
 * of "commands" that's just enough to exercise every method on the
 * SandboxSession contract.
 *
 * Recognized argv shapes (anything else is treated as "command not found"
 * and surfaces as exit 127, mirroring POSIX shell behaviour):
 *
 *   ['echo', ...args]           -> stdout = args.join(' ') + '\n', exit 0
 *   ['cat', path]               -> stdout = utf-8 of file at path, exit 0;
 *                                  exit 1 + stderr if missing
 *   ['true']                    -> exit 0
 *   ['false']                   -> exit 1
 *   ['exit', code]              -> exit `code` (parsed as int)
 *   ['sleep', ms]               -> resolves after `ms` ms; useful for timeout tests
 *   ['/bin/sh', '-c', script]   -> always exits 1 with stderr = script,
 *                                  intended as the "configurable error" knob
 *   ['stream-lines', ...lines]  -> for startStream tests; emits each `line`
 *                                  as a separate stdout event then exits 0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  RunOpts,
  RunResult,
  SandboxConfig,
  SandboxProvider,
  SandboxSession,
  StreamEvent,
} from './interface.js';

export class SandboxDestroyedError extends Error {
  constructor(id: string) {
    super(`sandbox session ${id} has been destroyed`);
    this.name = 'SandboxDestroyedError';
  }
}

export class SandboxFileNotFoundError extends Error {
  constructor(p: string) {
    super(`sandbox file not found: ${p}`);
    this.name = 'SandboxFileNotFoundError';
  }
}

export class SandboxTimeoutError extends Error {
  constructor(ms: number) {
    super(`sandbox command timed out after ${ms}ms`);
    this.name = 'SandboxTimeoutError';
  }
}

/** Normalize a sandbox-internal path. Always treats input as POSIX. */
function normalizeSandboxPath(p: string): string {
  return path.posix.normalize(p);
}

interface InMemorySessionState {
  id: string;
  files: Map<string, Uint8Array>;
  env: Record<string, string>;
  workingDir: string;
  destroyed: boolean;
}

class InMemorySession implements SandboxSession {
  readonly id: string;
  readonly #state: InMemorySessionState;

  constructor(state: InMemorySessionState) {
    this.id = state.id;
    this.#state = state;
  }

  #checkAlive(): void {
    if (this.#state.destroyed) {
      throw new SandboxDestroyedError(this.#state.id);
    }
  }

  async run(argv: string[], opts?: RunOpts): Promise<RunResult> {
    this.#checkAlive();
    const timeoutMs = opts?.timeout_ms;
    const exec = this.#execute(argv);
    if (timeoutMs !== undefined && timeoutMs >= 0) {
      return await withTimeout(exec, timeoutMs);
    }
    return await exec;
  }

  async *startStream(
    argv: string[],
    opts?: RunOpts,
  ): AsyncIterable<StreamEvent> {
    this.#checkAlive();
    void opts;

    // For the fixed command set we know the events up-front. We materialize
    // the event sequence first, then yield with `try/finally` so a consumer
    // that breaks early still gets cleanup (no leak — the iterator simply
    // stops; in a real provider this is where we'd kill the subprocess).
    const events = this.#streamEvents(argv);
    let cancelled = true;
    try {
      for (const ev of events) {
        // Yield each event on a microtask boundary so consumers can `break`
        // between events naturally.
        await Promise.resolve();
        yield ev;
      }
      cancelled = false;
    } finally {
      // Real provider would kill the underlying process here if `cancelled`.
      // For the in-memory provider there is nothing to clean up — but we
      // still mark this branch as exercised by the contract tests.
      void cancelled;
    }
  }

  #streamEvents(argv: string[]): StreamEvent[] {
    const head = argv[0];
    if (head === 'stream-lines') {
      const lines = argv.slice(1);
      const events: StreamEvent[] = lines.map((line) => ({
        kind: 'stdout' as const,
        data: line + '\n',
      }));
      events.push({ kind: 'exit', code: 0 });
      return events;
    }
    // Fall back to executing as a one-shot run and emitting one stdout +
    // (if non-empty) one stderr + exit. Build synchronously by replaying
    // the recognizers — but we don't want to block startStream on async,
    // so we use a small helper that is sync where possible. For the
    // minimal command set, only `cat` reads files (sync map lookup) so
    // this is fine.
    const result = this.#executeSync(argv);
    const events: StreamEvent[] = [];
    if (result.stdout.length > 0) {
      events.push({ kind: 'stdout', data: result.stdout });
    }
    if (result.stderr.length > 0) {
      events.push({ kind: 'stderr', data: result.stderr });
    }
    events.push({ kind: 'exit', code: result.exit_code });
    return events;
  }

  async readFile(p: string): Promise<Uint8Array> {
    this.#checkAlive();
    const key = normalizeSandboxPath(p);
    const bytes = this.#state.files.get(key);
    if (bytes === undefined) {
      throw new SandboxFileNotFoundError(p);
    }
    // Return a copy so callers can't mutate our backing store.
    return new Uint8Array(bytes);
  }

  async writeFile(p: string, content: Uint8Array): Promise<void> {
    this.#checkAlive();
    const key = normalizeSandboxPath(p);
    // "Create parent dirs as needed" — for in-memory we only track files,
    // so this is a no-op semantically; we still want to validate the path
    // is non-empty / absolute-ish so contract tests can verify behaviour.
    if (key === '' || key === '.' || key === '/') {
      throw new Error(`invalid sandbox path: ${p}`);
    }
    this.#state.files.set(key, new Uint8Array(content));
  }

  async uploadFile(hostPath: string, sandboxPath: string): Promise<void> {
    this.#checkAlive();
    const bytes = await fs.readFile(hostPath);
    await this.writeFile(sandboxPath, new Uint8Array(bytes));
  }

  async destroy(): Promise<void> {
    // Idempotent.
    this.#state.destroyed = true;
    this.#state.files.clear();
  }

  // ------- command execution -------

  async #execute(argv: string[]): Promise<RunResult> {
    const head = argv[0];

    // sleep is async; everything else is sync-shaped.
    if (head === 'sleep') {
      const msStr = argv[1] ?? '0';
      const ms = Number.parseInt(msStr, 10);
      if (!Number.isFinite(ms) || ms < 0) {
        return { exit_code: 1, stdout: '', stderr: `sleep: invalid duration\n` };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return { exit_code: 0, stdout: '', stderr: '' };
    }

    return this.#executeSync(argv);
  }

  #executeSync(argv: string[]): RunResult {
    const head = argv[0];

    if (head === undefined) {
      return { exit_code: 127, stdout: '', stderr: 'empty argv\n' };
    }

    if (head === 'echo') {
      return {
        exit_code: 0,
        stdout: argv.slice(1).join(' ') + '\n',
        stderr: '',
      };
    }

    if (head === 'cat') {
      const p = argv[1];
      if (p === undefined) {
        return { exit_code: 1, stdout: '', stderr: 'cat: missing path\n' };
      }
      const key = normalizeSandboxPath(p);
      const bytes = this.#state.files.get(key);
      if (bytes === undefined) {
        return {
          exit_code: 1,
          stdout: '',
          stderr: `cat: ${p}: No such file or directory\n`,
        };
      }
      return {
        exit_code: 0,
        stdout: new TextDecoder().decode(bytes),
        stderr: '',
      };
    }

    if (head === 'true') {
      return { exit_code: 0, stdout: '', stderr: '' };
    }

    if (head === 'false') {
      return { exit_code: 1, stdout: '', stderr: '' };
    }

    if (head === 'exit') {
      const codeStr = argv[1] ?? '0';
      const code = Number.parseInt(codeStr, 10);
      return {
        exit_code: Number.isFinite(code) ? code : 1,
        stdout: '',
        stderr: '',
      };
    }

    if (head === '/bin/sh') {
      // Configurable error knob: ['/bin/sh', '-c', script] always returns
      // exit 1 with the script echoed on stderr. Tests use this to verify
      // non-zero exit codes are returned (not thrown).
      const script = argv[2] ?? '';
      return { exit_code: 1, stdout: '', stderr: script };
    }

    if (head === 'stream-lines') {
      // If invoked through run(), collapse the lines into a single stdout.
      const lines = argv.slice(1);
      return {
        exit_code: 0,
        stdout: lines.map((l) => l + '\n').join(''),
        stderr: '',
      };
    }

    return {
      exit_code: 127,
      stdout: '',
      stderr: `${head}: command not found\n`,
    };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SandboxTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class InMemoryProvider implements SandboxProvider {
  #counter = 0;

  async create(config: SandboxConfig): Promise<SandboxSession> {
    this.#counter += 1;
    const id = `inmem-${String(this.#counter).padStart(4, '0')}`;
    const state: InMemorySessionState = {
      id,
      files: new Map(),
      env: { ...(config.env ?? {}) },
      workingDir: config.working_dir ?? '/',
      destroyed: false,
    };
    return new InMemorySession(state);
  }
}
