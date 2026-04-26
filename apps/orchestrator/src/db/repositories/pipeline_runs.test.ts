import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as runs from './pipeline_runs.js';
import {
  seedPipeline,
  seedProject,
  seedRequirement,
  seedRun,
} from '../__fixtures__/seed.js';

let db: Db;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
});

describe('pipeline_runs repository', () => {
  it('creates a run and reads it back', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = runs.createRun(db, {
      requirement_id: req.id,
      pipeline_snapshot_json: pipeline.definition_json,
      sandbox_session_id: null,
      per_repo_branches_json: { 'repo-1': 'auto-finish/req-x' },
    });
    expect(run.id).toBeTruthy();
    expect(run.started_at).toBeGreaterThan(0);
    expect(run.finished_at).toBeNull();

    const fetched = runs.getRun(db, run.id);
    expect(fetched?.per_repo_branches_json).toEqual({
      'repo-1': 'auto-finish/req-x',
    });
  });

  it('getRunByRequirement returns undefined when no runs', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    expect(runs.getRunByRequirement(db, req.id)).toBeUndefined();
  });

  it('getRunByRequirement returns the most recent run', async () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const r1 = seedRun(db, req, pipeline);
    await new Promise((r) => setTimeout(r, 5));
    const r2 = seedRun(db, req, pipeline);
    const latest = runs.getRunByRequirement(db, req.id);
    expect(latest?.id).toBe(r2.id);
    expect(latest?.id).not.toBe(r1.id);
  });

  it('finishRun sets finished_at', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const finished = runs.finishRun(db, run.id, 999_999);
    expect(finished?.finished_at).toBe(999_999);
  });
});
