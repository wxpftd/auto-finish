/**
 * SandboxProvider interface — the abstraction every sandbox backend
 * (Daytona local, Daytona cloud, Microsandbox, the in-memory test reference)
 * must satisfy.
 *
 * Pure type definitions only. No runtime code.
 */

/** Configuration for creating a new sandbox. */
export interface SandboxConfig {
  /** Container/microVM image to boot. Provider may have a default. */
  image?: string;
  /** Environment variables to set inside the sandbox. */
  env?: Record<string, string>;
  /** Commands to run after the sandbox boots, before it's handed back. */
  setup_commands?: string[];
  /** Default working directory for `run()` and `startStream()`. */
  working_dir?: string;
}

/** Per-call options for `run()` / `startStream()`. */
export interface RunOpts {
  /** Override the sandbox's default working directory. */
  cwd?: string;
  /** Extra environment variables for this call (merged on top of session env). */
  env?: Record<string, string>;
  /** Hard timeout in milliseconds; on expiry the call must reject. */
  timeout_ms?: number;
}

/** Final result of a `run()` call. */
export interface RunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Streaming event emitted by `startStream()`. */
export type StreamEvent =
  | { kind: 'stdout'; data: string }
  | { kind: 'stderr'; data: string }
  | { kind: 'exit'; code: number };

/**
 * A live sandbox session. Methods may only be called before `destroy()` —
 * after destroy, every method must reject (providers are expected to throw
 * a recognizable error; tests look for the word "destroyed" or an instance
 * of {@link SandboxDestroyedError}).
 */
export interface SandboxSession {
  /** Stable identifier for this session (non-empty). */
  readonly id: string;

  /**
   * Run a command inside the sandbox to completion.
   * Non-zero exit codes are returned in `RunResult`, NOT thrown.
   * Throws on transport errors, missing executables, or timeout.
   */
  run(argv: string[], opts?: RunOpts): Promise<RunResult>;

  /**
   * Start a long-running command and stream stdout/stderr back as they arrive.
   * The iterable must always end with exactly one `{ kind: 'exit' }` event,
   * unless the consumer breaks out early. Breaking early MUST clean up the
   * underlying process without leaks.
   */
  startStream(argv: string[], opts?: RunOpts): AsyncIterable<StreamEvent>;

  /** Read a file from the sandbox FS. Throws if path is missing. */
  readFile(path: string): Promise<Uint8Array>;

  /** Write bytes to a file in the sandbox FS. Creates parent dirs as needed. */
  writeFile(path: string, content: Uint8Array): Promise<void>;

  /** Copy a file from the host filesystem into the sandbox. */
  uploadFile(hostPath: string, sandboxPath: string): Promise<void>;

  /** Tear down the sandbox. Idempotent — calling twice must not throw. */
  destroy(): Promise<void>;
}

/** A factory that mints fresh `SandboxSession`s. */
export interface SandboxProvider {
  create(config: SandboxConfig): Promise<SandboxSession>;
}
