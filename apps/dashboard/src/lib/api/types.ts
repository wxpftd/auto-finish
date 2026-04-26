/**
 * Dashboard API types.
 *
 * Source-of-truth split:
 *   - Pipeline / Stage / Gate / Artifact (the *config* shapes) are re-exported
 *     from `@auto-finish/pipeline-schema`.
 *   - SandboxConfig / ClaudeConfig / RepoConfig / ProjectConfig (the *YAML
 *     config* shapes — used for create-form bodies, not for read paths) are
 *     re-exported from `@auto-finish/project-schema`.
 *   - DB-row shapes that the orchestrator's HTTP API actually returns
 *     (`Project`, `Repo`, `Requirement`, `PipelineRun`, `StageExecution`,
 *     `GateDecision`, `PullRequest`, `Artifact` row form) are mirrored from
 *     `apps/orchestrator/src/db/schema.ts` below. They differ from the YAML
 *     config types: e.g. the project row has `sandbox_config_json` /
 *     `claude_config_json` plus `created_at`/`updated_at`, and contains no
 *     inline `repos` array.
 *
 * NOTE: row types are mirrored from orchestrator/db/schema.ts; keep in sync —
 * TODO: codegen later.
 */

import type {
  Pipeline,
  Stage,
  Gate,
  Artifact as PipelineArtifactDef,
  StageAgentConfig,
  OnFailure,
} from '@auto-finish/pipeline-schema';

import type {
  ProjectConfig,
  RepoConfig,
  SandboxConfig,
  ClaudeConfig,
} from '@auto-finish/project-schema';

// Re-export pipeline config shapes (used in many places, including
// pipeline_snapshot inside a PipelineRun).
export type { Pipeline, Stage, Gate, PipelineArtifactDef, StageAgentConfig, OnFailure };

// Re-export project YAML config shapes for create-paths / form bodies.
export type { ProjectConfig, RepoConfig, SandboxConfig, ClaudeConfig };

// ---------------------------------------------------------------------------
// JSON column types — mirrored from orchestrator/db/schema.ts
// (these are the JSON-serialised shape returned over HTTP, not the YAML form)
// ---------------------------------------------------------------------------

/** JSON column shape on `projects.sandbox_config_json`. */
export interface SandboxConfigJson {
  provider: 'opensandbox' | 'in_memory';
  endpoint?: string;
  image?: string;
  env?: Record<string, string>;
  setup_commands?: string[];
  warm_strategy: 'baked_image' | 'shared_volume' | 'cold_only';
  warm_image?: string;
  base_image?: string;
  warm_volume_claim?: string;
  warm_mount_path?: string;
}

/** JSON column shape on `projects.claude_config_json`. */
export interface ClaudeConfigJson {
  credentials_source: 'host_mount' | 'secret_manager';
  allowed_tools?: string[];
  mcp_servers?: Record<string, unknown>;
}

/** JSON column shape on `pipeline_runs.per_repo_branches_json`. */
export type PerRepoBranches = Record<string, string>;

/** Loose stage-event envelope persisted on stage_executions.events_json. */
export interface StageEventRow {
  type: string;
  ts: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// DB row types — mirrored from orchestrator/db/schema.ts
// ---------------------------------------------------------------------------

/** Mirror of `projects` row. */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  default_pipeline_id: string | null;
  sandbox_config_json: SandboxConfigJson;
  claude_config_json: ClaudeConfigJson;
  created_at: number;
  updated_at: number;
}

/** Mirror of `repos` row. */
export interface Repo {
  id: string;
  project_id: string;
  name: string;
  git_url: string;
  default_branch: string;
  working_dir: string;
  test_command: string | null;
  pr_template: string | null;
  created_at: number;
}

export type RequirementStatus =
  | 'queued'
  | 'running'
  | 'awaiting_gate'
  | 'awaiting_changes'
  | 'done'
  | 'failed';

/** Mirror of `requirements` row. */
export interface Requirement {
  id: string;
  project_id: string;
  pipeline_id: string;
  title: string;
  description: string;
  source: string;
  source_ref: string | null;
  status: RequirementStatus | string; // server stores as text; widen for forward-compat
  current_stage_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Stage execution status — values seen in the orchestrator. */
export type StageExecutionStatus =
  | 'pending'
  | 'running'
  | 'awaiting_gate'
  | 'gate_approved'
  | 'gate_rejected'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | string;

/** Mirror of `stage_executions` row. */
export interface StageExecution {
  id: string;
  run_id: string;
  stage_name: string;
  status: StageExecutionStatus;
  claude_subprocess_pid: number | null;
  claude_session_id: string | null;
  started_at: number;
  finished_at: number | null;
  events_json: StageEventRow[];
}

/**
 * Mirror of `pipeline_runs` row, with the projection the orchestrator
 * `GET /api/runs/:id` route adds (`per_repo_branches` flattened, `stage_executions`
 * list joined in).
 */
export interface PipelineRun {
  id: string;
  requirement_id: string;
  pipeline_snapshot_json: Pipeline;
  sandbox_session_id: string | null;
  per_repo_branches_json: PerRepoBranches;
  /** Convenience alias projected by `GET /api/runs/:id`. */
  per_repo_branches?: PerRepoBranches;
  /** Joined-in stage rows, only when retrieved via `GET /api/runs/:id`. */
  stage_executions?: StageExecution[];
  started_at: number;
  finished_at: number | null;
}

export type ArtifactType = 'markdown' | 'json' | 'diff' | 'text' | 'directory' | string;

/** Mirror of `artifacts` row. */
export interface Artifact {
  id: string;
  stage_execution_id: string;
  path: string;
  type: ArtifactType;
  schema_id: string | null;
  content_hash: string;
  size: number;
  preview: string | null;
  storage_uri: string;
  created_at: number;
}

/** Decision the server accepts — note the wire-format strings (`approved` /
 * `rejected`), not the dashboard's old `approve` / `request_changes`. */
export type GateDecisionValue = 'approved' | 'rejected';

/** Mirror of `gate_decisions` row. */
export interface GateDecision {
  id: string;
  stage_execution_id: string;
  decided_by: string;
  decision: GateDecisionValue;
  feedback: string | null;
  decided_at: number;
}

export type PullRequestStatus =
  | 'open'
  | 'merged'
  | 'closed'
  | 'changes_requested'
  | string;

/** Mirror of `pull_requests` row. */
export interface PullRequest {
  id: string;
  run_id: string;
  repo_id: string;
  pr_url: string;
  pr_number: number;
  status: PullRequestStatus;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// View-model shapes used across the dashboard
// ---------------------------------------------------------------------------

export interface ProjectDetail {
  project: Project;
  repos: Repo[];
  requirements: Requirement[];
}

/**
 * The dashboard's aggregated requirement view. The orchestrator does not yet
 * expose a single endpoint that returns this; `HttpApi.getRequirement` stitches
 * it together from multiple calls.
 */
export interface RequirementDetail {
  requirement: Requirement;
  project: Project;
  pipeline: Pipeline;
  run: PipelineRun | null;
  artifacts: Artifact[];
  pull_requests: PullRequest[];
}

export interface RequirementListFilters {
  project_id?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Pipeline events — mirrored from orchestrator/src/pipeline/events.ts and
// orchestrator/src/eventbus/bus.ts. The dashboard receives these as JSON over
// the WebSocket bridge. Keep in sync with the orchestrator (TODO: codegen).
// ---------------------------------------------------------------------------

export interface RunStartedEvent {
  kind: 'run_started';
  run_id: string;
  requirement_id: string;
  at: string;
}

export interface StageStartedEvent {
  kind: 'stage_started';
  run_id: string;
  stage_name: string;
  at: string;
}

export interface StageArtifactProducedEvent {
  kind: 'stage_artifact_produced';
  run_id: string;
  stage_name: string;
  artifact_path: string;
}

export interface StageCompletedEvent {
  kind: 'stage_completed';
  run_id: string;
  stage_name: string;
  at: string;
  duration_ms: number;
}

export interface StageFailedEvent {
  kind: 'stage_failed';
  run_id: string;
  stage_name: string;
  at: string;
  error: string;
}

export interface GateRequiredEvent {
  kind: 'gate_required';
  run_id: string;
  stage_name: string;
  review_targets: string[];
}

export interface GateDecidedEvent {
  kind: 'gate_decided';
  run_id: string;
  stage_name: string;
  decision: 'approved' | 'rejected';
  feedback?: string;
}

export interface RunCompletedEvent {
  kind: 'run_completed';
  run_id: string;
  at: string;
}

export interface RunFailedEvent {
  kind: 'run_failed';
  run_id: string;
  at: string;
  error: string;
}

export interface RunPausedEvent {
  kind: 'run_paused';
  run_id: string;
  at: string;
  reason: string;
}

/**
 * Tier 2 cold-restart fallback fired for a stage: the orchestrator
 * destroyed the warm sandbox, recreated from `base_image`, and is about
 * to retry the same stage. Display-only — does not change run status.
 */
export interface ColdRestartEvent {
  kind: 'cold_restart';
  run_id: string;
  stage_name: string;
  at: string;
  reason: string;
}

export type PipelineEvent =
  | RunStartedEvent
  | StageStartedEvent
  | StageArtifactProducedEvent
  | StageCompletedEvent
  | StageFailedEvent
  | GateRequiredEvent
  | GateDecidedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunPausedEvent
  | ColdRestartEvent;

export type PipelineEventKind = PipelineEvent['kind'];

/** Wire-envelope sent by the orchestrator's WS bridge for every match. */
export interface BusMessage {
  topic: string;
  event: PipelineEvent;
  emitted_at: string;
}
