import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { repos } from '../schema.js';
import type { NewRepo, Repo } from '../schema.js';

export type AddRepoInput = Omit<NewRepo, 'id' | 'created_at'> & {
  id?: string;
};

export function addRepo(db: Db, input: AddRepoInput): Repo {
  const rows = db.insert(repos).values(input).returning().all();
  const row = rows[0];
  if (!row) throw new Error('addRepo: insert returned no row');
  return row;
}

export function listReposForProject(db: Db, project_id: string): Repo[] {
  return db.select().from(repos).where(eq(repos.project_id, project_id)).all();
}
