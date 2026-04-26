import { and, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../client.js';
import { requirements } from '../schema.js';
import type { NewRequirement, Requirement } from '../schema.js';

export type CreateRequirementInput = Omit<
  NewRequirement,
  'id' | 'created_at' | 'updated_at'
> & {
  id?: string;
};

export function createRequirement(
  db: Db,
  input: CreateRequirementInput,
): Requirement {
  const rows = db.insert(requirements).values(input).returning().all();
  const row = rows[0];
  if (!row) throw new Error('createRequirement: insert returned no row');
  return row;
}

export function getRequirement(db: Db, id: string): Requirement | undefined {
  return db
    .select()
    .from(requirements)
    .where(eq(requirements.id, id))
    .get();
}

export interface ListRequirementsFilter {
  project_id?: string;
  status?: string;
}

export function listRequirements(
  db: Db,
  filter: ListRequirementsFilter = {},
): Requirement[] {
  const conds: SQL[] = [];
  if (filter.project_id !== undefined) {
    conds.push(eq(requirements.project_id, filter.project_id));
  }
  if (filter.status !== undefined) {
    conds.push(eq(requirements.status, filter.status));
  }
  if (conds.length === 0) {
    return db.select().from(requirements).all();
  }
  // `and(...conds)` returns SQL | undefined when given 0 args; we already
  // narrowed that case above, so this is safe.
  return db.select().from(requirements).where(and(...conds)).all();
}

export function updateRequirementStatus(
  db: Db,
  id: string,
  status: string,
  current_stage_id?: string | null,
): Requirement | undefined {
  const patch: Record<string, unknown> = {
    status,
    updated_at: Date.now(),
  };
  if (current_stage_id !== undefined) {
    patch['current_stage_id'] = current_stage_id;
  }
  const rows = db
    .update(requirements)
    .set(patch)
    .where(eq(requirements.id, id))
    .returning()
    .all();
  return rows[0];
}
