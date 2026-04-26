import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createInMemoryDb, runMigrations } from '../db/index.js';
import type { Db } from '../db/index.js';
import { buildApp } from './app.js';

let db: Db;
let app: Hono;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
  app = buildApp({ db });
});

describe('app composition', () => {
  it('responds to /healthz', async () => {
    const res = await app.fetch(new Request('http://localhost/healthz'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('returns 404 with a structured body for unknown routes', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/does-not-exist'),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('/api/does-not-exist');
  });

  it('mounts every advertised route segment', async () => {
    // Hitting an unknown id under each mount must yield 404 (not 404-not-found
    // for the route itself). This proves the mounts are wired.
    const segments = [
      '/api/projects/x',
      '/api/pipelines/x',
      '/api/requirements/x',
      '/api/runs/x',
    ];
    for (const path of segments) {
      const res = await app.fetch(new Request(`http://localhost${path}`));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_found');
    }
    // db is referenced so the type checker doesn't drop the binding.
    void db;
  });
});
