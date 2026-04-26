/**
 * PR-suite test utility — a scriptable {@link SandboxSession} for exercising
 * `git ...` and `gh ...` argv flows without spawning subprocesses.
 *
 * Mirrors the multi-repo fake (we'll consolidate eventually) but lives under
 * `src/pr/` so this slice stays self-contained per Agent K's strict scope.
 *
 * - `run()` matches scripts by argv prefix; calls are consumed in order so
 *   identical commands hit successive scripts.
 * - Unmatched calls reject loudly so tests fail fast on unexpected commands.
 * - All recorded calls are exposed via `runCalls`, including the full argv,
 *   so tests can introspect what was sent (e.g. assert that the `gh pr edit`
 *   body contains a sibling PR URL).
 *
 * Type-only imports of the SandboxSession contract keep `verbatimModuleSyntax`
 * happy without dragging runtime sandbox code into the test bundle.
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
  /** Monotonic counter captured when the call was received. */
  invokedAt: number;
}

export type RunResponse = RunResult | Promise<RunResult> | Error;

export interface RunScript {
  /** argv prefix to match — call's first N tokens must equal these. */
  match: string[];
  /** Response producer. Called once per matching invocation, in order. */
  respond: (call: RunCall) => RunResponse;
}

export interface FakeSessionInit {
  id?: string;
  scripts?: RunScript[];
}

let monotonicCounter = 0;
function nextTick(): number {
  monotonicCounter += 1;
  return monotonicCounter;
}

export class FakeSession implements SandboxSession {
  readonly id: string;
  readonly runCalls: RunCall[] = [];
  readonly #scripts: RunScript[];

  constructor(init: FakeSessionInit = {}) {
    this.id = init.id ?? 'fake-pr-session';
    this.#scripts = [...(init.scripts ?? [])];
  }

  /** Append more scripts after construction. */
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
      throw new Error('FakeSession: internal — script lookup failed');
    }
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

  async writeFile(_path: string, _content: Uint8Array): Promise<void> {
    throw new Error('FakeSession.writeFile is not implemented');
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
