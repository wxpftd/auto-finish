/**
 * Runner public surface types.
 *
 * The runner orchestrates a single Requirement through its configured Pipeline,
 * end-to-end: bootstrap sandbox → clone repos → run each stage → gate → PRs.
 *
 * Most pieces (sandbox lifecycle, claude spawn, repo clone, PR open) are passed
 * in as functions so the same code drives production runs and unit tests.
 */

import type { Db } from '../db/index.js';
import type { EventBus } from '../eventbus/index.js';
import type { SandboxConfig as ProjectSandboxConfig } from '@auto-finish/project-schema';
import type {
  SandboxProvider,
  SandboxSession,
} from '../sandbox/interface.js';
import type { ClaudeStageEvent } from '../claude/stage-event.js';
import type { ClaudeInvocation } from '../claude/argv.js';
import type {
  CloneReport,
  RepoDiff,
  RepoSpec,
} from '../multi-repo/index.js';
import type { PublishedPullRequest } from '../pr/index.js';
import type { Requirement } from '../db/schema.js';

/** Result returned by `runRequirement` after the run terminates (or pauses). */
export type RunResult =
  | { status: 'completed'; prs: PublishedPullRequest[] }
  | { status: 'awaiting_changes'; stage_name: string; feedback?: string }
  | { status: 'paused'; stage_name: string; reason: string }
  | { status: 'failed'; error: string };

/** Bootstrap pluggable: clone repos + write manifest + inject creds. */
export interface BootstrapEnvFn {
  (args: {
    session: SandboxSession;
    repos: RepoSpec[];
    branchName: string;
    requirementId: string;
  }): Promise<CloneReport>;
}

/** Pluggable: detect post-stage diffs across repos. */
export interface DetectChangesFn {
  (args: {
    session: SandboxSession;
    repos: RepoSpec[];
    baseBranch: string;
    workingBranch: string;
  }): Promise<RepoDiff[]>;
}

/** Pluggable: open PRs for changed repos. */
export interface OpenPrsFn {
  (args: {
    session: SandboxSession;
    requirement: Pick<Requirement, 'id' | 'title' | 'description'>;
    perRepo: { repo: RepoSpec; diff: RepoDiff }[];
    branchName: string;
    baseBranch: (repo: RepoSpec) => string;
  }): Promise<PublishedPullRequest[]>;
}

/** Pluggable: stream claude events for a stage. */
export interface RunClaudeFn {
  (args: {
    session: SandboxSession;
    invocation: ClaudeInvocation;
  }): AsyncIterable<ClaudeStageEvent>;
}

/** Pluggable: inject claude credentials into a session. */
export interface InjectCredentialsFn {
  (session: SandboxSession): Promise<void>;
}

/**
 * Full runner dependencies. Required: db, bus, makeSandboxProvider.
 * Everything else has a real-implementation default; tests inject stubs.
 */
export interface RunnerDeps {
  db: Db;
  bus: EventBus;
  /** Pick a SandboxProvider given a project's sandbox_config. */
  makeSandboxProvider: (sandboxConfig: ProjectSandboxConfig) => SandboxProvider;
  /** Default: real bootstrapEnv (clone + manifest + creds). */
  bootstrapEnv?: BootstrapEnvFn;
  /** Default: real injectClaudeCredentials. */
  injectCredentials?: InjectCredentialsFn;
  /** Default: real runClaudeStage. */
  runClaude?: RunClaudeFn;
  /** Default: real detectChanges. */
  detectChanges?: DetectChangesFn;
  /** Default: real publishPullRequests. */
  openPrs?: OpenPrsFn;
  /** Default: `auto-finish/req-${id}`. */
  branchName?: (requirementId: string) => string;
  /** Default: `Date.now()`. */
  now?: () => number;
  /** How often to poll for gate decisions. Default: 1000ms. */
  gatePollIntervalMs?: number;
  /**
   * Default `max_turns` to apply when a stage doesn't specify one. Without
   * this the claude CLI uses its built-in default (50). Smoke testing has
   * shown 25 to be a safer cap that still leaves room for nontrivial work.
   * Default: 25.
   */
  defaultMaxTurns?: number;
  /** External cancellation hook. */
  signal?: AbortSignal;
}
