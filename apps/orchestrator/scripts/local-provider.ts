/**
 * Dev-only host-process SandboxProvider.
 *
 * Each session is a temporary directory on the host. `run` and `startStream`
 * spawn child processes there with inherited env, so Claude CLI finds host
 * credentials automatically (including macOS keychain). This is NOT a real
 * sandbox — there is no isolation. It exists only so we can drive
 * `runRequirement` end-to-end without standing up Daytona.
 *
 * Production must use DaytonaProvider / E2BProvider.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  SandboxConfig,
  SandboxProvider,
  SandboxSession,
  RunOpts,
  RunResult,
  StreamEvent,
} from '../src/sandbox/interface.js';

class LocalSession implements SandboxSession {
  readonly id: string;
  readonly #root: string;
  #destroyed = false;

  constructor(id: string, root: string) {
    this.id = id;
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  #checkAlive(): void {
    if (this.#destroyed) {
      throw new Error(`session destroyed: ${this.id}`);
    }
  }

  #resolve(p: string): string {
    return join(this.#root, p);
  }

  /**
   * Translate sandbox-internal absolute paths (`/workspace`, `/auto-finish`)
   * in an argv string so a host process can find them under the sandbox root.
   * Real container sandboxes don't need this; the kernel does it.
   */
  #translate(s: string): string {
    const PREFIXES = ['/workspace', '/auto-finish'];
    for (const p of PREFIXES) {
      if (s === p || s.startsWith(p + '/')) {
        return join(this.#root, s);
      }
    }
    const eq = s.indexOf('=');
    if (eq > 0) {
      const val = s.slice(eq + 1);
      for (const p of PREFIXES) {
        if (val === p || val.startsWith(p + '/')) {
          return s.slice(0, eq + 1) + join(this.#root, val);
        }
      }
    }
    return s;
  }

  #translateArgv(argv: string[]): string[] {
    return argv.map((a, i) => (i === 0 ? a : this.#translate(a)));
  }

  async run(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
    this.#checkAlive();
    if (argv.length === 0) {
      throw new Error('run: empty argv');
    }
    const translated = this.#translateArgv(argv);
    return new Promise((resolve, reject) => {
      const cwd = opts.cwd ? this.#resolve(opts.cwd) : this.#root;
      const child = spawn(translated[0]!, translated.slice(1), {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString('utf8');
      });
      child.stderr.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      const timer = opts.timeout_ms
        ? setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`run: timeout after ${opts.timeout_ms}ms`));
          }, opts.timeout_ms)
        : undefined;
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ exit_code: code ?? -1, stdout, stderr });
      });
    });
  }

  async *startStream(
    argv: string[],
    opts: RunOpts = {},
  ): AsyncIterable<StreamEvent> {
    this.#checkAlive();
    if (argv.length === 0) {
      throw new Error('startStream: empty argv');
    }
    const translated = this.#translateArgv(argv);
    const cwd = opts.cwd ? this.#resolve(opts.cwd) : this.#root;
    const child = spawn(translated[0]!, translated.slice(1), {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    type QueueItem =
      | { kind: 'event'; event: StreamEvent }
      | { kind: 'error'; error: Error }
      | { kind: 'done' };
    const queue: QueueItem[] = [];
    let waiter: ((item: QueueItem) => void) | null = null;

    const push = (item: QueueItem): void => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(item);
      } else {
        queue.push(item);
      }
    };

    child.stdout.on('data', (b: Buffer) => {
      push({ kind: 'event', event: { kind: 'stdout', data: b.toString('utf8') } });
    });
    child.stderr.on('data', (b: Buffer) => {
      push({ kind: 'event', event: { kind: 'stderr', data: b.toString('utf8') } });
    });
    child.on('error', (err) => {
      push({ kind: 'error', error: err });
    });
    child.on('close', (code) => {
      push({ kind: 'event', event: { kind: 'exit', code: code ?? -1 } });
      push({ kind: 'done' });
    });

    try {
      while (true) {
        const item: QueueItem = queue.length > 0
          ? queue.shift()!
          : await new Promise<QueueItem>((resolve) => {
              waiter = resolve;
            });
        if (item.kind === 'done') return;
        if (item.kind === 'error') throw item.error;
        yield item.event;
        if (item.event.kind === 'exit') return;
      }
    } finally {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.#checkAlive();
    const buf = await readFile(this.#resolve(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.#checkAlive();
    const full = this.#resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async uploadFile(hostPath: string, sandboxPath: string): Promise<void> {
    this.#checkAlive();
    const dest = this.#resolve(sandboxPath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(hostPath, dest);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    await rm(this.#root, { recursive: true, force: true });
  }
}

export interface LocalSandboxProviderOpts {
  /** When true, `session.destroy()` is a no-op (useful for forensics). */
  preserveOnDestroy?: boolean;
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly #opts: LocalSandboxProviderOpts;
  readonly #created: string[] = [];

  constructor(opts: LocalSandboxProviderOpts = {}) {
    this.#opts = opts;
  }

  /** Roots created by this provider, in creation order. */
  get createdRoots(): readonly string[] {
    return this.#created;
  }

  async create(_config: SandboxConfig): Promise<SandboxSession> {
    const id = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'auto-finish-smoke-'));
    this.#created.push(root);
    const session = new LocalSession(id, root);
    if (this.#opts.preserveOnDestroy === true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session as any).destroy = async () => {
        /* preserved for inspection */
      };
    }
    return session;
  }
}
