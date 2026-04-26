import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as requirements from './requirements.js';
import { seedPipeline, seedProject, seedRequirement } from '../__fixtures__/seed.js';

let db: Db;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
});

describe('requirements repository', () => {
  it('creates and fetches a requirement', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = requirements.createRequirement(db, {
      project_id: project.id,
      pipeline_id: pipeline.id,
      title: 'Add health endpoint',
      description: 'desc',
      source: 'manual',
      source_ref: null,
      status: 'queued',
      current_stage_id: null,
    });
    const fetched = requirements.getRequirement(db, req.id);
    expect(fetched?.title).toBe('Add health endpoint');
  });

  it('lists with no filter returns all', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    seedRequirement(db, project, pipeline, { title: 'a' });
    seedRequirement(db, project, pipeline, { title: 'b', status: 'running' });
    expect(requirements.listRequirements(db)).toHaveLength(2);
  });

  it('filters by project_id', () => {
    const project1 = seedProject(db, { name: 'p1' });
    const project2 = seedProject(db, { name: 'p2' });
    const pipeline = seedPipeline(db);
    seedRequirement(db, project1, pipeline);
    seedRequirement(db, project2, pipeline);
    const list = requirements.listRequirements(db, {
      project_id: project1.id,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.project_id).toBe(project1.id);
  });

  it('filters by status', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    seedRequirement(db, project, pipeline, { status: 'queued' });
    seedRequirement(db, project, pipeline, { status: 'running', title: 'r' });
    seedRequirement(db, project, pipeline, { status: 'queued', title: 'q2' });
    const list = requirements.listRequirements(db, { status: 'queued' });
    expect(list).toHaveLength(2);
  });

  it('filters by both project_id and status', () => {
    const project1 = seedProject(db, { name: 'p1' });
    const project2 = seedProject(db, { name: 'p2' });
    const pipeline = seedPipeline(db);
    seedRequirement(db, project1, pipeline, { status: 'queued' });
    seedRequirement(db, project1, pipeline, { status: 'running', title: 'r' });
    seedRequirement(db, project2, pipeline, { status: 'queued' });
    const list = requirements.listRequirements(db, {
      project_id: project1.id,
      status: 'queued',
    });
    expect(list).toHaveLength(1);
  });

  it('updates status and bumps updated_at', async () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    await new Promise((r) => setTimeout(r, 5));
    const updated = requirements.updateRequirementStatus(
      db,
      req.id,
      'running',
      'stage-1',
    );
    expect(updated?.status).toBe('running');
    expect(updated?.current_stage_id).toBe('stage-1');
    expect(updated?.updated_at).toBeGreaterThanOrEqual(req.updated_at);
  });

  it('updateRequirementStatus without current_stage_id leaves it untouched', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = requirements.createRequirement(db, {
      project_id: project.id,
      pipeline_id: pipeline.id,
      title: 't',
      description: 'd',
      source: 'manual',
      source_ref: null,
      status: 'queued',
      current_stage_id: 'orig-stage',
    });
    const updated = requirements.updateRequirementStatus(
      db,
      req.id,
      'running',
    );
    expect(updated?.status).toBe('running');
    expect(updated?.current_stage_id).toBe('orig-stage');
  });

  it('returns undefined when updating unknown id', () => {
    expect(
      requirements.updateRequirementStatus(db, 'missing', 'done'),
    ).toBeUndefined();
  });
});
