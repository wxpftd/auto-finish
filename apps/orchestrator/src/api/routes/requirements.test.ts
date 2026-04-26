import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createInMemoryDb,
  runMigrations,
  projects,
  pipelines,
  pipeline_runs,
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
      agent_config: {
        system_prompt: 'analyze',
        allowed_tools: ['Read'],
      },
      artifacts: [],
      on_failure: 'pause',
    },
  ],
};

function jsonRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

interface SeedResult {
  projectId: string;
  pipelineId: string;
}

function seedProjectAndPipeline(): SeedResult {
  const project = projects.createProject(db, {
    name: 'demo',
    description: null,
    default_pipeline_id: null,
    sandbox_config_json: {},
    claude_config_json: { credentials_source: 'host_mount' },
  });
  const pipeline = pipelines.createPipeline(db, {
    name: 'demo-pipeline',
    version: '1',
    definition_json: samplePipeline,
  });
  return { projectId: project.id, pipelineId: pipeline.id };
}

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
  app = buildApp({ db });
});

describe('requirements route', () => {
  it('creates a requirement with status=queued', async () => {
    const { projectId, pipelineId } = seedProjectAndPipeline();
    const res = await app.fetch(
      jsonRequest('/api/requirements', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          pipeline_id: pipelineId,
          title: 'add /health endpoint',
          description: 'expose a /health endpoint on the backend',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      requirement: { id: string; status: string };
    };
    expect(body.requirement.status).toBe('queued');
  });

  it('lists requirements with status filter', async () => {
    const { projectId, pipelineId } = seedProjectAndPipeline();
    await app.fetch(
      jsonRequest('/api/requirements', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          pipeline_id: pipelineId,
          title: 'a',
          description: 'a',
        }),
      }),
    );
    await app.fetch(
      jsonRequest('/api/requirements', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          pipeline_id: pipelineId,
          title: 'b',
          description: 'b',
        }),
      }),
    );

    const all = await app.fetch(jsonRequest('/api/requirements'));
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { requirements: unknown[] };
    expect(allBody.requirements).toHaveLength(2);

    const filtered = await app.fetch(
      jsonRequest('/api/requirements?status=queued'),
    );
    const filteredBody = (await filtered.json()) as {
      requirements: unknown[];
    };
    expect(filteredBody.requirements).toHaveLength(2);

    const noMatch = await app.fetch(
      jsonRequest('/api/requirements?status=done'),
    );
    const noMatchBody = (await noMatch.json()) as { requirements: unknown[] };
    expect(noMatchBody.requirements).toHaveLength(0);
  });

  it('rejects body missing required fields', async () => {
    const res = await app.fetch(
      jsonRequest('/api/requirements', {
        method: 'POST',
        body: JSON.stringify({ title: 'no project' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown requirement id', async () => {
    const res = await app.fetch(jsonRequest('/api/requirements/missing'));
    expect(res.status).toBe(404);
  });

  it('lists pipeline_runs for a requirement', async () => {
    const { projectId, pipelineId } = seedProjectAndPipeline();
    const created = await app.fetch(
      jsonRequest('/api/requirements', {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          pipeline_id: pipelineId,
          title: 'r',
          description: 'r',
        }),
      }),
    );
    const { requirement } = (await created.json()) as {
      requirement: { id: string };
    };

    const empty = await app.fetch(
      jsonRequest(`/api/requirements/${requirement.id}/runs`),
    );
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { runs: unknown[] };
    expect(emptyBody.runs).toEqual([]);

    pipeline_runs.createRun(db, {
      requirement_id: requirement.id,
      pipeline_snapshot_json: samplePipeline,
      sandbox_session_id: null,
      per_repo_branches_json: { 'frontend': 'auto/x' },
    });

    const filled = await app.fetch(
      jsonRequest(`/api/requirements/${requirement.id}/runs`),
    );
    const filledBody = (await filled.json()) as { runs: unknown[] };
    expect(filledBody.runs).toHaveLength(1);

    const missing = await app.fetch(
      jsonRequest('/api/requirements/nope/runs'),
    );
    expect(missing.status).toBe(404);
  });
});
