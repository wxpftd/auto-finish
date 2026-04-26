import type { Db } from '../client.js';
import * as projectsRepo from '../repositories/projects.js';
import * as pipelinesRepo from '../repositories/pipelines.js';
import * as reposRepo from '../repositories/repos.js';
import * as requirementsRepo from '../repositories/requirements.js';
import * as runsRepo from '../repositories/pipeline_runs.js';
import * as stageRepo from '../repositories/stage_executions.js';
import type {
  PipelineRow,
  PipelineRun,
  Project,
  Repo,
  Requirement,
  StageExecution,
} from '../schema.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';

export const samplePipelineDef: Pipeline = {
  id: 'pipe-1',
  name: 'default',
  stages: [
    {
      name: 'analyze',
      agent_config: { system_prompt: 'analyze', allowed_tools: [] },
      artifacts: [],
      on_failure: 'pause',
    },
    {
      name: 'design',
      agent_config: { system_prompt: 'design', allowed_tools: [] },
      artifacts: [],
      on_failure: 'pause',
    },
  ],
};

export function seedProject(db: Db, overrides: Partial<Project> = {}): Project {
  return projectsRepo.createProject(db, {
    name: overrides.name ?? 'demo',
    description: overrides.description ?? null,
    default_pipeline_id: overrides.default_pipeline_id ?? null,
    sandbox_config_json: overrides.sandbox_config_json ?? {},
    claude_config_json: overrides.claude_config_json ?? {
      credentials_source: 'host_mount',
    },
  });
}

export function seedPipeline(
  db: Db,
  overrides: { name?: string; version?: string; definition?: Pipeline } = {},
): PipelineRow {
  return pipelinesRepo.createPipeline(db, {
    name: overrides.name ?? 'default',
    version: overrides.version ?? '1.0.0',
    definition_json: overrides.definition ?? samplePipelineDef,
  });
}

export function seedRepo(
  db: Db,
  project: Project,
  overrides: { name?: string } = {},
): Repo {
  return reposRepo.addRepo(db, {
    project_id: project.id,
    name: overrides.name ?? 'frontend',
    git_url: 'git@example.com:frontend.git',
    default_branch: 'main',
    working_dir: `/workspace/${overrides.name ?? 'frontend'}`,
    test_command: 'npm test',
    pr_template: null,
  });
}

export function seedRequirement(
  db: Db,
  project: Project,
  pipeline: PipelineRow,
  overrides: { status?: string; title?: string } = {},
): Requirement {
  return requirementsRepo.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: overrides.title ?? 'Add health endpoint',
    description: 'Add /health endpoint to backend',
    source: 'manual',
    source_ref: null,
    status: overrides.status ?? 'queued',
    current_stage_id: null,
  });
}

export function seedRun(
  db: Db,
  requirement: Requirement,
  pipeline: PipelineRow,
): PipelineRun {
  return runsRepo.createRun(db, {
    requirement_id: requirement.id,
    pipeline_snapshot_json: pipeline.definition_json,
    sandbox_session_id: null,
    per_repo_branches_json: {},
  });
}

export function seedStageExecution(
  db: Db,
  run: PipelineRun,
  overrides: { stage_name?: string; status?: string } = {},
): StageExecution {
  return stageRepo.createStageExecution(db, {
    run_id: run.id,
    stage_name: overrides.stage_name ?? 'analyze',
    status: overrides.status ?? 'running',
    claude_subprocess_pid: null,
    claude_session_id: null,
  });
}
