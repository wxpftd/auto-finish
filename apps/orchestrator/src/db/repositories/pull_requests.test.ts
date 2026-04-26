import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as prs from './pull_requests.js';
import {
  seedPipeline,
  seedProject,
  seedRepo,
  seedRequirement,
  seedRun,
} from '../__fixtures__/seed.js';

let db: Db;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
});

describe('pull_requests repository', () => {
  it('records a PR and lists it for the run', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const repo = seedRepo(db, project, { name: 'frontend' });

    const pr = prs.recordPR(db, {
      run_id: run.id,
      repo_id: repo.id,
      pr_url: 'https://github.com/owner/frontend/pull/1',
      pr_number: 1,
      status: 'open',
    });
    expect(pr.id).toBeTruthy();

    const list = prs.listPRsForRun(db, run.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.pr_number).toBe(1);
  });

  it('updates PR status', async () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const repo = seedRepo(db, project, { name: 'frontend' });
    const pr = prs.recordPR(db, {
      run_id: run.id,
      repo_id: repo.id,
      pr_url: 'x',
      pr_number: 1,
      status: 'open',
    });
    await new Promise((r) => setTimeout(r, 5));
    const updated = prs.updatePRStatus(db, pr.id, 'merged');
    expect(updated?.status).toBe('merged');
    expect(updated?.updated_at).toBeGreaterThanOrEqual(pr.updated_at);
  });

  it('listPRsForRun returns empty array when none exist', () => {
    expect(prs.listPRsForRun(db, 'nonexistent')).toEqual([]);
  });

  it('lists PRs across multiple repos for a run', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const frontend = seedRepo(db, project, { name: 'frontend' });
    const backend = seedRepo(db, project, { name: 'backend' });
    prs.recordPR(db, {
      run_id: run.id,
      repo_id: frontend.id,
      pr_url: 'x',
      pr_number: 1,
      status: 'open',
    });
    prs.recordPR(db, {
      run_id: run.id,
      repo_id: backend.id,
      pr_url: 'y',
      pr_number: 2,
      status: 'open',
    });
    expect(prs.listPRsForRun(db, run.id)).toHaveLength(2);
  });
});
