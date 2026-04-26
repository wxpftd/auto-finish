/**
 * SandboxProvider interface — the abstraction every sandbox backend
 * (OpenSandbox in production, the in-memory test reference) must satisfy.
 *
 * Pure type definitions only. No runtime code.
 */

/**
 * Volume backend selector. Maps onto OpenSandbox OSEP-0003's three supported
 * volume sources:
 *   - `host`   — local Docker named volume / bind-mount path on the host;
 *                an explicit absolute `path` may be provided. When unset,
 *                `OpenSandboxProvider` falls back to `VolumeBinding.mountPath`
 *                (the bind-mount-equals-mount-path convention).
 *   - `pvc`    — Kubernetes PersistentVolumeClaim (claimName-addressed)
 *   - `ossfs`  — Aliyun OSS bucket mounted as a filesystem
 *
 * `kind: 'host'` is the default when `VolumeBinding.backend` is unset.
 * The in-memory provider doesn't speak OSEP-0003 and silently ignores the
 * entire `volumes` field, so widening this discriminated union is
 * non-breaking — only OpenSandboxProvider reads `backend`.
 */
export type VolumeBackend =
  | { kind: 'host'; path?: string }
  | { kind: 'pvc'; claimName: string }
  | { kind: 'ossfs'; bucket: string; endpoint?: string };

/**
 * One named volume / persistent claim mounted into a sandbox at create time.
 * Maps directly onto OpenSandbox's `volumes[]` field; the in-memory
 * provider ignores it (no persistent-volume support).
 */
export interface VolumeBinding {
  /** Volume identifier — Docker named volume or K8s PVC `claimName`. */
  name: string;
  /** Absolute path inside the sandbox where the volume mounts. */
  mountPath: string;
  /** Mount read-only. Default: false. */
  readOnly?: boolean;
  /** Optional sub-path inside the volume to mount instead of root. */
  subPath?: string;
  /**
   * Backend selector (OpenSandbox OSEP-0003). Defaults to `{ kind: 'host' }`
   * when unset. Only OpenSandboxProvider consumes this — other providers
   * ignore the entire `volumes` field.
   */
  backend?: VolumeBackend;
}

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
  /**
   * Persistent volumes to attach. Used by warm-workspace strategies
   * (`shared_volume`) to mount a deps cache. Providers that don't support
   * volumes should ignore this field rather than throwing.
   */
  volumes?: VolumeBinding[];
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
