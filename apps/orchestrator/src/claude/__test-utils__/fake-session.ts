/**
 * Hand-rolled fake `SandboxSession` for the spawn / credentials tests.
 *
 * We don't extend or modify the in-memory provider — keeping the fake
 * inline (and tiny) avoids coupling claude tests to sandbox-internal
 * test plumbing, and lets each test assert on a small, well-typed surface.
 */

import type {
  RunOpts,
  RunResult,
  SandboxSession,
  StreamEvent,
} from '../../sandbox/interface.js';

export interface UploadFileCall {
  hostPath: string;
  sandboxPath: string;
}

export interface RunCall {
  argv: string[];
  opts: RunOpts | undefined;
}

export interface FakeSessionOptions {
  /** Default exit/stdout/stderr for `run`. Overridden per-call by `runImpl`. */
  defaultRunResult?: RunResult;
  /** Per-call hook; if returned non-undefined, replaces defaultRunResult. */
  runImpl?: (argv: string[], opts: RunOpts | undefined) => Promise<RunResult>;
  /** Sequence of events that `startStream` will emit. */
  streamEvents?: readonly StreamEvent[];
  /**
   * If set, `startStream` throws this error AFTER emitting
   * `streamEvents` (or immediately, if `streamEvents` is empty). Used to
   * simulate transport failures mid-iteration.
   */
  streamThrowAfterEvents?: Error;
  /** If true, every `run` call rejects with this error. */
  runError?: Error;
  /** If true, every `uploadFile` call rejects with this error. */
  uploadError?: Error;
}

export class FakeSession implements SandboxSession {
  readonly id: string = 'fake-session-1';

  readonly uploadCalls: UploadFileCall[] = [];
  readonly runCalls: RunCall[] = [];
  readonly streamArgvCalls: string[][] = [];

  #destroyed = false;
  #files = new Map<string, Uint8Array>();

  constructor(private readonly options: FakeSessionOptions = {}) {}

  async run(argv: string[], opts?: RunOpts): Promise<RunResult> {
    if (this.#destroyed) throw new Error('session has been destroyed');
    this.runCalls.push({ argv, opts });
    if (this.options.runError) throw this.options.runError;
    if (this.options.runImpl) return this.options.runImpl(argv, opts);
    return (
      this.options.defaultRunResult ?? { exit_code: 0, stdout: '', stderr: '' }
    );
  }

  async *startStream(
    argv: string[],
    _opts?: RunOpts,
  ): AsyncIterable<StreamEvent> {
    if (this.#destroyed) throw new Error('session has been destroyed');
    this.streamArgvCalls.push(argv);
    const events = this.options.streamEvents ?? [];
    for (const ev of events) {
      // Yield on a microtask so consumers can `break` between events.
      await Promise.resolve();
      yield ev;
    }
    if (this.options.streamThrowAfterEvents) {
      throw this.options.streamThrowAfterEvents;
    }
  }

  async readFile(p: string): Promise<Uint8Array> {
    if (this.#destroyed) throw new Error('session has been destroyed');
    const bytes = this.#files.get(p);
    if (!bytes) throw new Error(`fake: file not found: ${p}`);
    return new Uint8Array(bytes);
  }

  async writeFile(p: string, content: Uint8Array): Promise<void> {
    if (this.#destroyed) throw new Error('session has been destroyed');
    this.#files.set(p, new Uint8Array(content));
  }

  async uploadFile(hostPath: string, sandboxPath: string): Promise<void> {
    if (this.#destroyed) throw new Error('session has been destroyed');
    this.uploadCalls.push({ hostPath, sandboxPath });
    if (this.options.uploadError) throw this.options.uploadError;
  }

  async destroy(): Promise<void> {
    this.#destroyed = true;
  }
}
