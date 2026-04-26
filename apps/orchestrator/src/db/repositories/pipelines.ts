import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { pipelines } from '../schema.js';
import type { NewPipelineRow, PipelineRow } from '../schema.js';

export type CreatePipelineInput = Omit<NewPipelineRow, 'id' | 'created_at'> & {
  id?: string;
};

export function createPipeline(db: Db, input: CreatePipelineInput): PipelineRow {
  const rows = db.insert(pipelines).values(input).returning().all();
  const row = rows[0];
  if (!row) throw new Error('createPipeline: insert returned no row');
  return row;
}

export function getPipeline(db: Db, id: string): PipelineRow | undefined {
  return db.select().from(pipelines).where(eq(pipelines.id, id)).get();
}

export function listPipelines(db: Db): PipelineRow[] {
  return db.select().from(pipelines).all();
}
