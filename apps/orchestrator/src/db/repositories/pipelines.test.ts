import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as pipelines from './pipelines.js';
import { samplePipelineDef } from '../__fixtures__/seed.js';

let db: Db;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
});

describe('pipelines repository', () => {
  it('creates and fetches a pipeline by id', () => {
    const created = pipelines.createPipeline(db, {
      name: 'default',
      version: '1.0.0',
      definition_json: samplePipelineDef,
    });
    const fetched = pipelines.getPipeline(db, created.id);
    expect(fetched?.name).toBe('default');
    expect(fetched?.definition_json).toEqual(samplePipelineDef);
  });

  it('listPipelines returns all created pipelines', () => {
    pipelines.createPipeline(db, {
      name: 'a',
      version: '1',
      definition_json: samplePipelineDef,
    });
    pipelines.createPipeline(db, {
      name: 'b',
      version: '1',
      definition_json: samplePipelineDef,
    });
    expect(pipelines.listPipelines(db)).toHaveLength(2);
  });
});
