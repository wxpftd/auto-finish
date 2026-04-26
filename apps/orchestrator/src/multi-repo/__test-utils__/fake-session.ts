/**
 * Test utility — a lightweight, scriptable {@link SandboxSession} stand-in.
 *
 * - Records every `run()` and `writeFile()` invocation in order, with a
 *   monotonic timestamp captured at the moment the call entered the fake
 *   (BEFORE awaiting any scripted response). Tests use these timestamps to
 *   assert ordering / parallelism.
 * - For `run()`, the user supplies a list of "scripts": each script matches
 *   on an argv prefix and yields either a synchronous response or a promise
 *   that the test can resolve manually (via {@link deferred}) to control
 *   timing.
 * - Unmatched `run()` calls reject loudly so tests fail fast on unexpected
 *   commands.
 *
 * Pure type-only imports from `../../sandbox/interface.js` keep
 * `verbatimModuleSyntax` happy and avoid pulling runtime sandbox code.
 */
import type {
  RunOpts,
  RunResult,
  SandboxSession,
  StreamEvent,
} from '../../sandbox/interface.js';

export interface RunCall {
  argv: string[];
  opts: RunOpts | undefined;
  /** Monotonic timestamp captured when the call was received. */
  invokedAt: number;
}

export interface WriteCall {
  path: string;
  content: Uint8Array;
  invokedAt: number;
}

export type RunResponse = RunResult | Promise<RunResult> | Error;

export interface RunScript {
  /** argv prefix to match (call's first N tokens must equal these). */
  match: string[];
  /** Response producer. Called once per matching invocation, in order. */
  respond: (call: RunCall) => RunResponse;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** A manually-resolvable promise for controlling parallel-call ordering. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let monotonicCounter = 0;
function nextTick(): number {
  monotonicCounter += 1;
  return monotonicCounter;
}

export interface FakeSessionInit {
  id?: string;
  scripts?: RunScript[];
}

export class FakeSession implements SandboxSession {
  readonly id: string;
  readonly runCalls: RunCall[] = [];
  readonly writeCalls: WriteCall[] = [];
  readonly #scripts: RunScript[];

  constructor(init: FakeSessionInit = {}) {
    this.id = init.id ?? 'fake-session';
    // Copy so tests can keep mutating their input array between sessions.
    this.#scripts = [...(init.scripts ?? [])];
  }

  /** Append more scripts after construction (helpful when tests defer setup). */
  addScripts(scripts: RunScript[]): void {
    for (const s of scripts) this.#scripts.push(s);
  }

  async run(argv: string[], opts?: RunOpts): Promise<RunResult> {
    const call: RunCall = { argv: [...argv], opts, invokedAt: nextTick() };
    this.runCalls.push(call);
    const idx = this.#scripts.findIndex((s) => prefixMatches(s.match, argv));
    if (idx === -1) {
      throw new Error(
        `FakeSession: no script matched argv ${JSON.stringify(argv)}`,
      );
    }
    const script = this.#scripts[idx];
    if (script === undefined) {
      // Defensive — findIndex returned a valid index above, but
      // noUncheckedIndexedAccess wants this guard.
      throw new Error('FakeSession: internal — script lookup failed');
    }
    // Scripts are consumed in order: remove on first match so subsequent
    // identical calls hit the next entry.
    this.#scripts.splice(idx, 1);
    const response = script.respond(call);
    if (response instanceof Error) {
      throw response;
    }
    return await Promise.resolve(response);
  }

  startStream(_argv: string[], _opts?: RunOpts): AsyncIterable<StreamEvent> {
    throw new Error('FakeSession.startStream is not implemented');
  }

  async readFile(_path: string): Promise<Uint8Array> {
    throw new Error('FakeSession.readFile is not implemented');
  }

  async writeFile(p: string, content: Uint8Array): Promise<void> {
    this.writeCalls.push({
      path: p,
      content: new Uint8Array(content),
      invokedAt: nextTick(),
    });
  }

  async uploadFile(_hostPath: string, _sandboxPath: string): Promise<void> {
    throw new Error('FakeSession.uploadFile is not implemented');
  }

  async destroy(): Promise<void> {
    // No-op for tests.
  }
}

function prefixMatches(prefix: string[], argv: string[]): boolean {
  if (prefix.length > argv.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== argv[i]) return false;
  }
  return true;
}

/** Convenience builder for a successful RunResult. */
export function ok(stdout = '', stderr = ''): RunResult {
  return { exit_code: 0, stdout, stderr };
}

/** Convenience builder for a failed RunResult (non-zero exit). */
export function fail(exit_code: number, stderr = '', stdout = ''): RunResult {
  return { exit_code, stdout, stderr };
}
