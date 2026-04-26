import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createInMemoryDb,
  runMigrations,
  projects,
  repos,
  pipelines,
  requirements,
  pipeline_runs,
  stage_executions,
  pull_requests,
} from '../../db/index.js';
import type { Db } from '../../db/index.js';
import { buildApp } from '../app.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';

let db: Db;
let app: Hono;

const samplePipeline: Pipeline = {
  id: 'p1',
  name: 'minimal',
  version: '1',
  stages: [
    {
      name: 'analyze',
      agent_config: { system_prompt: 'analyze', allowed_tools: ['Read'] },
      artifacts: [],
      on_failure: 'pause',
    },
  ],
};

interface SeedResult {
  runId: string;
  stageId: string;
  repoId: string;
}

function seedRunWithStage(): SeedResult {
  const project = projects.createProject(db, {
    name: 'demo',
    description: null,
    default_pipeline_id: null,
    sandbox_config_json: {},
    claude_config_json: { credentials_source: 'host_mount' },
  });
  const repoRow = repos.addRepo(db, {
    project_id: project.id,
    name: 'frontend',
    git_url: 'https://example.com/frontend.git',
    default_branch: 'main',
    working_dir: '/workspace/frontend',
    test_command: null,
    pr_template: null,
  });
  const pipeline = pipelines.createPipeline(db, {
    name: 'pipeline',
    version: '1',
    definition_json: samplePipeline,
  });
  const requirement = requirements.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: 't',
    description: 'd',
    source: 'manual',
    source_ref: null,
    status: 'queued',
    current_stage_id: null,
  });
  const run = pipeline_runs.createRun(db, {
    requirement_id: requirement.id,
    pipeline_snapshot_json: samplePipeline,
    sandbox_session_id: null,
    per_repo_branches_json: { [repoRow.id]: 'auto-finish/req-1' },
  });
  const stage = stage_executions.createStageExecution(db, {
    run_id: run.id,
    stage_name: 'analyze',
    status: 'running',
    claude_subprocess_pid: null,
    claude_session_id: null,
    events_json: [
      { type: 'log', ts: 1, message: 'starting' },
      { type: 'log', ts: 2, message: 'mid' },
    ],
  });
  return { runId: run.id, stageId: stage.id, repoId: repoRow.id };
}

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
  app = buildApp({ db });
});

describe('runs route', () => {
  it('returns a run with nested stages and per_repo_branches', async () => {
    const { runId, repoId } = seedRunWithStage();
    const res = await app.fetch(
      new Request(`http://localhost/api/runs/${runId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: {
        id: string;
        per_repo_branches: Record<string, string>;
        stage_executions: { id: string; stage_name: string }[];
      };
    };
    expect(body.run.id).toBe(runId);
    expect(body.run.per_repo_branches[repoId]).toBe('auto-finish/req-1');
    expect(body.run.stage_executions).toHaveLength(1);
    expect(body.run.stage_executions[0]?.stage_name).toBe('analyze');
  });

  it('returns 404 for unknown run', async () => {
    const res = await app.fetch(new Request('http://localhost/api/runs/missing'));
    expect(res.status).toBe(404);
  });

  it('lists stages for a run', async () => {
    const { runId } = seedRunWithStage();
    const res = await app.fetch(
      new Request(`http://localhost/api/runs/${runId}/stages`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage_executions: unknown[] };
    expect(body.stage_executions).toHaveLength(1);
  });

  it('flattens stage events for the run', async () => {
    const { runId } = seedRunWithStage();
    const res = await app.fetch(
      new Request(`http://localhost/api/runs/${runId}/events`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { type: string; stage_name: string }[];
    };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]?.stage_name).toBe('analyze');
  });

  it('returns 404 for events on unknown run', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/runs/missing/events'),
    );
    expect(res.status).toBe(404);
  });

  it('lists pull_requests for a run', async () => {
    const { runId, repoId } = seedRunWithStage();
    pull_requests.recordPR(db, {
      run_id: runId,
      repo_id: repoId,
      pr_url: 'https://example.com/pr/1',
      pr_number: 1,
      status: 'open',
    });

    const res = await app.fetch(
      new Request(`http://localhost/api/runs/${runId}/prs`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pull_requests: { pr_number: number }[];
    };
    expect(body.pull_requests).toHaveLength(1);
    expect(body.pull_requests[0]?.pr_number).toBe(1);
  });
});
