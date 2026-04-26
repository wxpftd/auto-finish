import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createInMemoryDb,
  runMigrations,
  projects,
  pipelines,
  requirements,
  pipeline_runs,
  stage_executions,
} from '../../db/index.js';
import type { Db } from '../../db/index.js';
import { buildApp } from '../app.js';
import { EventBus } from '../../eventbus/index.js';
import type { BusMessage } from '../../eventbus/index.js';
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

function jsonRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

interface SeedStage {
  stageId: string;
  runId: string;
}

function seedAwaitingGate(): SeedStage {
  const project = projects.createProject(db, {
    name: 'demo',
    description: null,
    default_pipeline_id: null,
    sandbox_config_json: {},
    claude_config_json: { credentials_source: 'host_mount' },
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
    status: 'awaiting_gate',
    current_stage_id: null,
  });
  const run = pipeline_runs.createRun(db, {
    requirement_id: requirement.id,
    pipeline_snapshot_json: samplePipeline,
    sandbox_session_id: null,
    per_repo_branches_json: {},
  });
  const stage = stage_executions.createStageExecution(db, {
    run_id: run.id,
    stage_name: 'design',
    status: 'awaiting_gate',
    claude_subprocess_pid: null,
    claude_session_id: null,
    events_json: [],
  });
  return { stageId: stage.id, runId: run.id };
}

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
  app = buildApp({ db });
});

describe('gates route', () => {
  it('lists pending gates', async () => {
    seedAwaitingGate();
    const res = await app.fetch(jsonRequest('/api/gates/pending'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stage_executions: { id: string; status: string }[];
    };
    expect(body.stage_executions).toHaveLength(1);
    expect(body.stage_executions[0]?.status).toBe('awaiting_gate');
  });

  it('approves a pending gate and updates the stage status', async () => {
    const { stageId } = seedAwaitingGate();
    const res = await app.fetch(
      jsonRequest(`/api/gates/${stageId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          decided_by: 'alice@example.com',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      decision: { decision: string; decided_by: string };
      stage: { status: string };
    };
    expect(body.decision.decision).toBe('approved');
    expect(body.stage.status).toBe('gate_approved');
  });

  it('records a rejection', async () => {
    const { stageId } = seedAwaitingGate();
    const res = await app.fetch(
      jsonRequest(`/api/gates/${stageId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'rejected',
          decided_by: 'bob@example.com',
          feedback: 'design looks wrong',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      decision: { decision: string; feedback: string | null };
      stage: { status: string };
    };
    expect(body.decision.decision).toBe('rejected');
    expect(body.decision.feedback).toBe('design looks wrong');
    expect(body.stage.status).toBe('gate_rejected');
  });

  it('returns 404 for unknown stage_execution_id', async () => {
    const res = await app.fetch(
      jsonRequest('/api/gates/missing/decide', {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          decided_by: 'alice@example.com',
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('rejects body with invalid decision value', async () => {
    const { stageId } = seedAwaitingGate();
    const res = await app.fetch(
      jsonRequest(`/api/gates/${stageId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'yes-please',
          decided_by: 'alice@example.com',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 when a decision already exists for the stage', async () => {
    const { stageId } = seedAwaitingGate();
    const first = await app.fetch(
      jsonRequest(`/api/gates/${stageId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          decided_by: 'alice@example.com',
        }),
      }),
    );
    expect(first.status).toBe(201);

    const dup = await app.fetch(
      jsonRequest(`/api/gates/${stageId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'rejected',
          decided_by: 'alice@example.com',
        }),
      }),
    );
    expect(dup.status).toBe(409);
  });

  it('publishes a gate_decided event on the bus when one is provided (Fix #11)', async () => {
    const bus = new EventBus();
    const messages: BusMessage[] = [];
    bus.subscribe('*', (msg) => {
      messages.push(msg);
    });
    // Replace the default app with one that has the bus wired.
    app = buildApp({ db, bus });

    const { stageId, runId } = seedAwaitingGate();
    const res = await app.fetch(
      jsonRequest(`/api/gates/${stageId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          decided_by: 'alice@example.com',
          feedback: 'looks good',
        }),
      }),
    );
    expect(res.status).toBe(201);

    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.topic).toBe(`run:${runId}`);
    expect(msg.event.kind).toBe('gate_decided');
    if (msg.event.kind === 'gate_decided') {
      expect(msg.event.run_id).toBe(runId);
      expect(msg.event.stage_name).toBe('design');
      expect(msg.event.decision).toBe('approved');
      expect(msg.event.feedback).toBe('looks good');
    }
  });

  it('does not publish anything when no bus is configured (backward compat)', async () => {
    // Default `app` was built without a bus in beforeEach. We just need to
    // verify the route still works (already covered in earlier tests). This
    // test is a regression guard for the optional-bus signature change.
    const { stageId } = seedAwaitingGate();
    const res = await app.fetch(
      jsonRequest(`/api/gates/${stageId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          decided_by: 'alice@example.com',
        }),
      }),
    );
    expect(res.status).toBe(201);
  });
});
