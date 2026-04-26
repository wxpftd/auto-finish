import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { stage_executions } from '../schema.js';
import type {
  NewStageExecution,
  StageEvent,
  StageExecution,
} from '../schema.js';

export type CreateStageExecutionInput = Omit<
  NewStageExecution,
  'id' | 'started_at' | 'finished_at' | 'events_json'
> & {
  id?: string;
  events_json?: StageEvent[];
};

export function createStageExecution(
  db: Db,
  input: CreateStageExecutionInput,
): StageExecution {
  const rows = db
    .insert(stage_executions)
    .values({
      ...input,
      events_json: input.events_json ?? [],
    })
    .returning()
    .all();
  const row = rows[0];
  if (!row) throw new Error('createStageExecution: insert returned no row');
  return row;
}

export function getStageExecution(
  db: Db,
  id: string,
): StageExecution | undefined {
  return db
    .select()
    .from(stage_executions)
    .where(eq(stage_executions.id, id))
    .get();
}

/**
 * Atomically append one event to the stage execution's `events_json` array.
 *
 * better-sqlite3 transactions are synchronous, which is exactly what we want
 * here: read-modify-write inside a single SQLite transaction so concurrent
 * appends don't clobber each other.
 */
export function appendEvent(
  db: Db,
  id: string,
  event: StageEvent,
): StageExecution {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(stage_executions)
      .where(eq(stage_executions.id, id))
      .get();
    if (!current) {
      throw new Error(`appendEvent: stage execution not found: ${id}`);
    }
    const next = [...current.events_json, event];
    const rows = tx
      .update(stage_executions)
      .set({ events_json: next })
      .where(eq(stage_executions.id, id))
      .returning()
      .all();
    const updated = rows[0];
    if (!updated) {
      throw new Error('appendEvent: update returned no row');
    }
    return updated;
  });
}

export interface FinishStageExecutionInput {
  status: string;
  finished_at?: number;
}

export function finishStageExecution(
  db: Db,
  id: string,
  patch: FinishStageExecutionInput,
): StageExecution | undefined {
  const rows = db
    .update(stage_executions)
    .set({
      status: patch.status,
      finished_at: patch.finished_at ?? Date.now(),
    })
    .where(eq(stage_executions.id, id))
    .returning()
    .all();
  return rows[0];
}

export interface SetClaudeSessionInput {
  claude_session_id?: string;
  claude_subprocess_pid?: number;
}

/**
 * Lift the Claude `session_id` (and optionally subprocess PID) from the
 * stage's first `session_init` event into top-level columns on the row.
 *
 * Only the columns that callers explicitly pass are written. Both columns are
 * nullable in the schema, so omitting one leaves any prior value untouched.
 * Returns the updated row, or `undefined` if the row no longer exists.
 */
export function setClaudeSession(
  db: Db,
  id: string,
  args: SetClaudeSessionInput,
): StageExecution | undefined {
  const patch: Partial<{
    claude_session_id: string;
    claude_subprocess_pid: number;
  }> = {};
  if (args.claude_session_id !== undefined) {
    patch.claude_session_id = args.claude_session_id;
  }
  if (args.claude_subprocess_pid !== undefined) {
    patch.claude_subprocess_pid = args.claude_subprocess_pid;
  }
  if (Object.keys(patch).length === 0) {
    // Nothing to update; just return the current row (or undefined).
    return getStageExecution(db, id);
  }
  const rows = db
    .update(stage_executions)
    .set(patch)
    .where(eq(stage_executions.id, id))
    .returning()
    .all();
  return rows[0];
}
