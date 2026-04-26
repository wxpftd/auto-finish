import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { projects } from '../schema.js';
import type { NewProject, Project } from '../schema.js';

export type CreateProjectInput = Omit<NewProject, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
};

export function createProject(db: Db, input: CreateProjectInput): Project {
  const rows = db.insert(projects).values(input).returning().all();
  const row = rows[0];
  if (!row) throw new Error('createProject: insert returned no row');
  return row;
}

export function getProject(db: Db, id: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).all();
}

export type UpdateProjectInput = Partial<
  Omit<NewProject, 'id' | 'created_at' | 'updated_at'>
>;

export function updateProject(
  db: Db,
  id: string,
  patch: UpdateProjectInput,
): Project | undefined {
  const rows = db
    .update(projects)
    .set({ ...patch, updated_at: Date.now() })
    .where(eq(projects.id, id))
    .returning()
    .all();
  return rows[0];
}
