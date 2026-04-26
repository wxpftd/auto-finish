import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createInMemoryDb, runMigrations } from '../../db/index.js';
import type { Db } from '../../db/index.js';
import { schema } from '../../db/index.js';
import { buildApp } from '../app.js';

let db: Db;
let app: Hono;

function jsonRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const validProjectBody = {
  name: 'demo',
  description: 'demo project',
  sandbox_config: { provider: 'opensandbox' as const, image: 'node:20' },
  claude_config: { credentials_source: 'host_mount' as const },
};

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
  app = buildApp({ db });
});

describe('projects route', () => {
  it('creates and lists a project', async () => {
    const create = await app.fetch(
      jsonRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify(validProjectBody),
      }),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      project: { id: string; name: string };
    };
    expect(created.project.name).toBe('demo');

    const list = await app.fetch(jsonRequest('/api/projects'));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { projects: unknown[] };
    expect(listBody.projects).toHaveLength(1);
  });

  it('rejects body missing claude_config', async () => {
    const res = await app.fetch(
      jsonRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: 'demo',
          sandbox_config: {},
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown project id', async () => {
    const res = await app.fetch(jsonRequest('/api/projects/missing'));
    expect(res.status).toBe(404);
  });

  it('lists repos for a project (404 when project unknown)', async () => {
    const create = await app.fetch(
      jsonRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify(validProjectBody),
      }),
    );
    const created = (await create.json()) as { project: { id: string } };

    const empty = await app.fetch(
      jsonRequest(`/api/projects/${created.project.id}/repos`),
    );
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { repos: unknown[] };
    expect(emptyBody.repos).toEqual([]);

    const missing = await app.fetch(jsonRequest('/api/projects/nope/repos'));
    expect(missing.status).toBe(404);
  });

  it('adds a repo to a project', async () => {
    const create = await app.fetch(
      jsonRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify(validProjectBody),
      }),
    );
    const { project } = (await create.json()) as { project: { id: string } };

    const addRes = await app.fetch(
      jsonRequest(`/api/projects/${project.id}/repos`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'frontend',
          git_url: 'https://example.com/frontend.git',
          default_branch: 'main',
          working_dir: '/workspace/frontend',
        }),
      }),
    );
    expect(addRes.status).toBe(201);
    const addBody = (await addRes.json()) as {
      repo: { id: string; name: string; project_id: string };
    };
    expect(addBody.repo.name).toBe('frontend');
    expect(addBody.repo.project_id).toBe(project.id);
  });

  it('rejects POST /:id/repos with bad body', async () => {
    const create = await app.fetch(
      jsonRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify(validProjectBody),
      }),
    );
    const { project } = (await create.json()) as { project: { id: string } };

    const res = await app.fetch(
      jsonRequest(`/api/projects/${project.id}/repos`, {
        method: 'POST',
        body: JSON.stringify({ name: 'bad' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('creates a project + repos atomically from yaml', async () => {
    const fixturePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '__fixtures__',
      'project.json',
    );
    const yaml = readFileSync(fixturePath, 'utf8');

    const res = await app.fetch(
      jsonRequest('/api/projects/from-yaml', {
        method: 'POST',
        body: JSON.stringify({ project_yaml: yaml }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      project: { id: string; name: string };
      repos: { id: string; name: string }[];
    };
    expect(body.project.name).toBe('demo-fullstack');
    expect(body.repos).toHaveLength(2);
    expect(body.repos.map((r) => r.name).sort()).toEqual(['backend', 'frontend']);

    // Confirm rows are actually persisted (not just echoed back).
    const projectRows = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, body.project.id))
      .all();
    expect(projectRows).toHaveLength(1);
    const repoRows = db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.project_id, body.project.id))
      .all();
    expect(repoRows).toHaveLength(2);
  });

  it('rolls back from-yaml when YAML is invalid', async () => {
    const before = db.select().from(schema.projects).all().length;
    const res = await app.fetch(
      jsonRequest('/api/projects/from-yaml', {
        method: 'POST',
        body: JSON.stringify({ project_yaml: '{ "name": "x" }' }),
      }),
    );
    expect(res.status).toBe(400);
    const after = db.select().from(schema.projects).all().length;
    expect(after).toBe(before);
  });
});
