import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createInMemoryDb, runMigrations } from '../../db/index.js';
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
        system_prompt: 'analyze the requirement',
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

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
  app = buildApp({ db });
});

describe('pipelines route', () => {
  it('creates a pipeline from a structured definition', async () => {
    const res = await app.fetch(
      jsonRequest('/api/pipelines', {
        method: 'POST',
        body: JSON.stringify({
          name: 'demo',
          definition: samplePipeline,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pipeline: { id: string; name: string } };
    expect(body.pipeline.name).toBe('demo');
    expect(body.pipeline.id).toBeTruthy();
  });

  it('lists created pipelines', async () => {
    await app.fetch(
      jsonRequest('/api/pipelines', {
        method: 'POST',
        body: JSON.stringify({ name: 'demo', definition: samplePipeline }),
      }),
    );
    const res = await app.fetch(jsonRequest('/api/pipelines'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pipelines: unknown[] };
    expect(body.pipelines).toHaveLength(1);
  });

  it('rejects a body that supplies neither definition nor yaml', async () => {
    const res = await app.fetch(
      jsonRequest('/api/pipelines', {
        method: 'POST',
        body: JSON.stringify({ name: 'demo' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toBe('validation_failed');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('rejects a body that supplies BOTH definition and yaml', async () => {
    const res = await app.fetch(
      jsonRequest('/api/pipelines', {
        method: 'POST',
        body: JSON.stringify({
          name: 'demo',
          definition: samplePipeline,
          yaml: 'id: p1\nname: x\nstages: []\n',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown pipeline id', async () => {
    const res = await app.fetch(jsonRequest('/api/pipelines/nope'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns 400 on malformed JSON body', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/pipelines', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});
