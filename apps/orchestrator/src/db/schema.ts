/**
 * SQLite schema for the auto-finish orchestrator persistence layer.
 *
 * Conventions
 * ----------
 *  - All IDs are string primary keys, default-filled with `crypto.randomUUID()`
 *    (UUID is fine for MVP; a ULID lib can be swapped in later by changing the
 *    helper without touching call sites).
 *  - Timestamps are stored as unix milliseconds (`integer`), defaulted via
 *    `$defaultFn(() => Date.now())`. We deliberately avoid drizzle's
 *    `mode: 'timestamp_ms'` because that maps the column to `Date` in JS;
 *    we want plain numbers everywhere so JSON-serialising rows is trivial.
 *  - JSON-bearing columns use `text({ mode: 'json' }).$type<...>()`. The
 *    `$type` is type-level only; round-tripping is exercised in tests.
 *  - Status / source / decision columns are stored as plain text and validated
 *    in the application layer (see repositories). Keeping them as text makes
 *    schema migrations cheaper as the enum set evolves.
 *
 * FK cascade policy (justification per FK)
 * ----------------------------------------
 *   repos.project_id              ON DELETE CASCADE  (a project owns its repos)
 *   requirements.project_id       ON DELETE CASCADE  (deleting a project drops its work)
 *   requirements.pipeline_id      ON DELETE RESTRICT (preserve audit / pipeline history)
 *   pipeline_runs.requirement_id  ON DELETE CASCADE
 *   stage_executions.run_id       ON DELETE CASCADE
 *   artifacts.stage_execution_id  ON DELETE CASCADE
 *   gate_decisions.stage_execution_id ON DELETE CASCADE  (one decision per execution; unique)
 *   pull_requests.run_id          ON DELETE CASCADE
 *   pull_requests.repo_id         ON DELETE RESTRICT (don't lose PR records if a repo row is deleted)
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { Pipeline } from '@auto-finish/pipeline-schema';
import type { SandboxConfig as ProjectSandboxConfig } from '@auto-finish/project-schema';

// ---------------------------------------------------------------------------
// JSON column types
// ---------------------------------------------------------------------------

/**
 * Stored shape of `projects.sandbox_config_json`.
 *
 * Aliased to the project-schema's `SandboxConfig` so the YAML form, the DB
 * row, and the runner all agree. Defaults for `provider` / `warm_strategy`
 * are applied at parse time by `parseProjectYaml` — by the time we reach
 * this type, both fields are populated.
 */
export type SandboxConfig = ProjectSandboxConfig;

export interface ClaudeConfig {
  credentials_source: 'host_mount' | 'secret_manager';
  allowed_tools?: string[];
  mcp_servers?: Record<string, unknown>;
}

export type PerRepoBranches = Record<string, string>;

/**
 * Stage event captured during execution (e.g. parsed claude stream-json frames,
 * orchestrator-side state transitions). The shape is intentionally open at the
 * persistence boundary; producers/consumers narrow with their own zod schemas.
 */
export interface StageEvent {
  type: string;
  ts: number;
  // Allow arbitrary additional payload so different producers can extend
  // without breaking the persistence contract.
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const newId = (): string => crypto.randomUUID();
const nowMs = (): number => Date.now();

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  description: text('description'),
  default_pipeline_id: text('default_pipeline_id'),
  sandbox_config_json: text('sandbox_config_json', { mode: 'json' })
    .$type<SandboxConfig>()
    .notNull(),
  claude_config_json: text('claude_config_json', { mode: 'json' })
    .$type<ClaudeConfig>()
    .notNull(),
  created_at: integer('created_at').notNull().$defaultFn(nowMs),
  updated_at: integer('updated_at').notNull().$defaultFn(nowMs),
});

export const repos = sqliteTable(
  'repos',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    git_url: text('git_url').notNull(),
    default_branch: text('default_branch').notNull(),
    working_dir: text('working_dir').notNull(),
    test_command: text('test_command'),
    pr_template: text('pr_template'),
    created_at: integer('created_at').notNull().$defaultFn(nowMs),
  },
  (t) => [uniqueIndex('repos_project_name_unique').on(t.project_id, t.name)],
);

export const pipelines = sqliteTable('pipelines', {
  id: text('id').primaryKey().$defaultFn(newId),
  name: text('name').notNull(),
  version: text('version').notNull(),
  definition_json: text('definition_json', { mode: 'json' })
    .$type<Pipeline>()
    .notNull(),
  created_at: integer('created_at').notNull().$defaultFn(nowMs),
});

export const requirements = sqliteTable(
  'requirements',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    pipeline_id: text('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    source: text('source').notNull(),
    source_ref: text('source_ref'),
    status: text('status').notNull(),
    current_stage_id: text('current_stage_id'),
    created_at: integer('created_at').notNull().$defaultFn(nowMs),
    updated_at: integer('updated_at').notNull().$defaultFn(nowMs),
  },
  (t) => [index('requirements_project_status_idx').on(t.project_id, t.status)],
);

export const pipeline_runs = sqliteTable(
  'pipeline_runs',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    requirement_id: text('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    pipeline_snapshot_json: text('pipeline_snapshot_json', { mode: 'json' })
      .$type<Pipeline>()
      .notNull(),
    sandbox_session_id: text('sandbox_session_id'),
    per_repo_branches_json: text('per_repo_branches_json', { mode: 'json' })
      .$type<PerRepoBranches>()
      .notNull(),
    started_at: integer('started_at').notNull().$defaultFn(nowMs),
    finished_at: integer('finished_at'),
  },
  (t) => [index('pipeline_runs_requirement_idx').on(t.requirement_id)],
);

export const stage_executions = sqliteTable(
  'stage_executions',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    run_id: text('run_id')
      .notNull()
      .references(() => pipeline_runs.id, { onDelete: 'cascade' }),
    stage_name: text('stage_name').notNull(),
    status: text('status').notNull(),
    claude_subprocess_pid: integer('claude_subprocess_pid'),
    claude_session_id: text('claude_session_id'),
    started_at: integer('started_at').notNull().$defaultFn(nowMs),
    finished_at: integer('finished_at'),
    events_json: text('events_json', { mode: 'json' })
      .$type<StageEvent[]>()
      .notNull(),
  },
  (t) => [index('stage_executions_run_idx').on(t.run_id)],
);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey().$defaultFn(newId),
  stage_execution_id: text('stage_execution_id')
    .notNull()
    .references(() => stage_executions.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  type: text('type').notNull(),
  schema_id: text('schema_id'),
  content_hash: text('content_hash').notNull(),
  size: integer('size').notNull(),
  preview: text('preview'),
  storage_uri: text('storage_uri').notNull(),
  created_at: integer('created_at').notNull().$defaultFn(nowMs),
});

export const gate_decisions = sqliteTable(
  'gate_decisions',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    stage_execution_id: text('stage_execution_id')
      .notNull()
      .references(() => stage_executions.id, { onDelete: 'cascade' }),
    decided_by: text('decided_by').notNull(),
    decision: text('decision').notNull(),
    feedback: text('feedback'),
    decided_at: integer('decided_at').notNull().$defaultFn(nowMs),
  },
  (t) => [
    uniqueIndex('gate_decisions_stage_execution_unique').on(t.stage_execution_id),
  ],
);

export const pull_requests = sqliteTable(
  'pull_requests',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    run_id: text('run_id')
      .notNull()
      .references(() => pipeline_runs.id, { onDelete: 'cascade' }),
    repo_id: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'restrict' }),
    pr_url: text('pr_url').notNull(),
    pr_number: integer('pr_number').notNull(),
    status: text('status').notNull(),
    created_at: integer('created_at').notNull().$defaultFn(nowMs),
    updated_at: integer('updated_at').notNull().$defaultFn(nowMs),
  },
  (t) => [uniqueIndex('pull_requests_run_repo_unique').on(t.run_id, t.repo_id)],
);

// ---------------------------------------------------------------------------
// Inferred row types (handy for callers / repositories)
// ---------------------------------------------------------------------------

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;

export type PipelineRow = typeof pipelines.$inferSelect;
export type NewPipelineRow = typeof pipelines.$inferInsert;

export type Requirement = typeof requirements.$inferSelect;
export type NewRequirement = typeof requirements.$inferInsert;

export type PipelineRun = typeof pipeline_runs.$inferSelect;
export type NewPipelineRun = typeof pipeline_runs.$inferInsert;

export type StageExecution = typeof stage_executions.$inferSelect;
export type NewStageExecution = typeof stage_executions.$inferInsert;

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

export type GateDecision = typeof gate_decisions.$inferSelect;
export type NewGateDecision = typeof gate_decisions.$inferInsert;

export type PullRequest = typeof pull_requests.$inferSelect;
export type NewPullRequest = typeof pull_requests.$inferInsert;
