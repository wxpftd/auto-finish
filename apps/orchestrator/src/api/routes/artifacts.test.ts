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
  artifacts as artifactsRepo,
  type Db,
} from '../../db/index.js';
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
      agent_config: {},
      artifacts: [],
      on_failure: 'pause',
    },
  ],
};

interface Seeded {
  runId: string;
  stageId: string;
}

function seed(): Seeded {
  const project = projects.createProject(db, {
    name: 'demo',
    description: null,
    default_pipeline_id: null,
    sandbox_config_json: {},
    claude_config_json: { credentials_source: 'host_mount' },
  });
  repos.addRepo(db, {
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
    project_id: project.id,
    definition_json: samplePipeline,
  });
  const req = requirements.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: 'demo',
    description: 'd',
    source: 'manual',
    source_ref: null,
    status: 'queued',
    current_stage_id: null,
  });
  const run = pipeline_runs.createRun(db, {
    requirement_id: req.id,
    pipeline_snapshot_json: samplePipeline,
    sandbox_session_id: 'sess',
    per_repo_branches_json: {},
  });
  const stage = stage_executions.createStageExecution(db, {
    run_id: run.id,
    stage_name: 'analyze',
    status: 'running',
  });
  return { runId: run.id, stageId: stage.id };
}

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
  app = buildApp({ db });
});

describe('GET /api/artifacts/run/:run_id', () => {
  it('returns 404 for unknown run', async () => {
    const res = await app.request('/api/artifacts/run/missing');
    expect(res.status).toBe(404);
  });

  it('lists artifacts attached to any stage of the run', async () => {
    const { runId, stageId } = seed();
    artifactsRepo.createArtifact(db, {
      stage_execution_id: stageId,
      path: 'frontend.patch',
      type: 'diff',
      content: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
      preview: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
      storage_uri: 'inline://',
    });
    const res = await app.request(`/api/artifacts/run/${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: { path: string; type: string }[] };
    expect(body.artifacts.length).toBe(1);
    expect(body.artifacts[0]?.path).toBe('frontend.patch');
    expect(body.artifacts[0]?.type).toBe('diff');
  });
});

describe('GET /api/artifacts/stage/:stage_execution_id', () => {
  it('returns 404 for unknown stage', async () => {
    const res = await app.request('/api/artifacts/stage/missing');
    expect(res.status).toBe(404);
  });

  it('lists artifacts on the given stage only', async () => {
    const { stageId } = seed();
    artifactsRepo.createArtifact(db, {
      stage_execution_id: stageId,
      path: 'a.patch',
      type: 'diff',
      content: 'a',
      storage_uri: 'inline://',
    });
    const res = await app.request(`/api/artifacts/stage/${stageId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(body.artifacts.length).toBe(1);
  });
});

describe('GET /api/artifacts/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/artifacts/missing');
    expect(res.status).toBe(404);
  });

  it('returns the full artifact row including preview content', async () => {
    const { stageId } = seed();
    const a = artifactsRepo.createArtifact(db, {
      stage_execution_id: stageId,
      path: 'x.patch',
      type: 'diff',
      content: 'patch text body',
      preview: 'patch text body',
      storage_uri: 'inline://',
    });
    const res = await app.request(`/api/artifacts/${a.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact: { preview: string; storage_uri: string } };
    expect(body.artifact.preview).toBe('patch text body');
    expect(body.artifact.storage_uri).toBe('inline://');
  });
});
