import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { pull_requests } from '../schema.js';
import type { NewPullRequest, PullRequest } from '../schema.js';

export type RecordPRInput = Omit<
  NewPullRequest,
  'id' | 'created_at' | 'updated_at'
> & {
  id?: string;
};

export function recordPR(db: Db, input: RecordPRInput): PullRequest {
  const rows = db.insert(pull_requests).values(input).returning().all();
  const row = rows[0];
  if (!row) throw new Error('recordPR: insert returned no row');
  return row;
}

export function updatePRStatus(
  db: Db,
  id: string,
  status: string,
): PullRequest | undefined {
  const rows = db
    .update(pull_requests)
    .set({ status, updated_at: Date.now() })
    .where(eq(pull_requests.id, id))
    .returning()
    .all();
  return rows[0];
}

export function listPRsForRun(db: Db, run_id: string): PullRequest[] {
  return db
    .select()
    .from(pull_requests)
    .where(eq(pull_requests.run_id, run_id))
    .all();
}
