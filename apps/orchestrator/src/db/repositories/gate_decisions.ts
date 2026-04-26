import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { gate_decisions } from '../schema.js';
import type { GateDecision, NewGateDecision } from '../schema.js';

export type RecordDecisionInput = Omit<
  NewGateDecision,
  'id' | 'decided_at'
> & {
  id?: string;
  decided_at?: number;
};

export function recordDecision(
  db: Db,
  input: RecordDecisionInput,
): GateDecision {
  const rows = db.insert(gate_decisions).values(input).returning().all();
  const row = rows[0];
  if (!row) throw new Error('recordDecision: insert returned no row');
  return row;
}

export function getDecision(
  db: Db,
  stage_execution_id: string,
): GateDecision | undefined {
  return db
    .select()
    .from(gate_decisions)
    .where(eq(gate_decisions.stage_execution_id, stage_execution_id))
    .get();
}
