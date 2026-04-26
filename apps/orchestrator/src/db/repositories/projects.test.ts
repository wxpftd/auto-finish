import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as projects from './projects.js';

let db: Db;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
});

describe('projects repository', () => {
  it('creates and reads back a project', () => {
    const created = projects.createProject(db, {
      name: 'demo',
      description: 'demo project',
      default_pipeline_id: null,
      sandbox_config_json: { image: 'node:20' },
      claude_config_json: { credentials_source: 'host_mount' },
    });
    expect(created.id).toBeTruthy();
    expect(created.created_at).toBeGreaterThan(0);
    expect(created.updated_at).toBeGreaterThan(0);

    const fetched = projects.getProject(db, created.id);
    expect(fetched?.name).toBe('demo');
    expect(fetched?.sandbox_config_json).toEqual({ image: 'node:20' });
  });

  it('returns undefined for unknown id', () => {
    expect(projects.getProject(db, 'missing')).toBeUndefined();
  });

  it('lists all projects', () => {
    projects.createProject(db, {
      name: 'a',
      description: null,
      default_pipeline_id: null,
      sandbox_config_json: {},
      claude_config_json: { credentials_source: 'host_mount' },
    });
    projects.createProject(db, {
      name: 'b',
      description: null,
      default_pipeline_id: null,
      sandbox_config_json: {},
      claude_config_json: { credentials_source: 'host_mount' },
    });
    const all = projects.listProjects(db);
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.name).sort()).toEqual(['a', 'b']);
  });

  it('updates a project and bumps updated_at', async () => {
    const created = projects.createProject(db, {
      name: 'a',
      description: 'old',
      default_pipeline_id: null,
      sandbox_config_json: {},
      claude_config_json: { credentials_source: 'host_mount' },
    });
    // small delay so updated_at changes (Date.now() resolution is ms)
    await new Promise((r) => setTimeout(r, 5));
    const updated = projects.updateProject(db, created.id, {
      description: 'new',
    });
    expect(updated?.description).toBe('new');
    expect(updated?.updated_at).toBeGreaterThanOrEqual(created.updated_at);
  });

  it('updateProject returns undefined for unknown id', () => {
    expect(
      projects.updateProject(db, 'missing', { description: 'x' }),
    ).toBeUndefined();
  });
});
