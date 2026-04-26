import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { pipeline_runs } from '../schema.js';
import type { NewPipelineRun, PipelineRun } from '../schema.js';

export type CreateRunInput = Omit<
  NewPipelineRun,
  'id' | 'started_at' | 'finished_at'
> & {
  id?: string;
};

export function createRun(db: Db, input: CreateRunInput): PipelineRun {
  const rows = db.insert(pipeline_runs).values(input).returning().all();
  const row = rows[0];
  if (!row) throw new Error('createRun: insert returned no row');
  return row;
}

export function getRun(db: Db, id: string): PipelineRun | undefined {
  return db
    .select()
    .from(pipeline_runs)
    .where(eq(pipeline_runs.id, id))
    .get();
}

/**
 * Return the most recent run for a requirement (by `started_at`), if any.
 * A requirement may have multiple runs over its lifetime (e.g. on retry).
 */
export function getRunByRequirement(
  db: Db,
  requirement_id: string,
): PipelineRun | undefined {
  const rows = db
    .select()
    .from(pipeline_runs)
    .where(eq(pipeline_runs.requirement_id, requirement_id))
    .all();
  if (rows.length === 0) return undefined;
  return rows.reduce<PipelineRun>((acc, row) => {
    return row.started_at > acc.started_at ? row : acc;
  }, rows[0] as PipelineRun);
}

export function finishRun(
  db: Db,
  id: string,
  finished_at: number = Date.now(),
): PipelineRun | undefined {
  const rows = db
    .update(pipeline_runs)
    .set({ finished_at })
    .where(eq(pipeline_runs.id, id))
    .returning()
    .all();
  return rows[0];
}
