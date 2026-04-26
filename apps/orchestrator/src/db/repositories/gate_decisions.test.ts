import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as gate from './gate_decisions.js';
import {
  seedPipeline,
  seedProject,
  seedRequirement,
  seedRun,
  seedStageExecution,
} from '../__fixtures__/seed.js';

let db: Db;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  db = handle.db;
});

describe('gate_decisions repository', () => {
  it('records a decision and reads it back', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const exec = seedStageExecution(db, run);

    const decision = gate.recordDecision(db, {
      stage_execution_id: exec.id,
      decided_by: 'reviewer@x',
      decision: 'approved',
      feedback: null,
    });
    expect(decision.decision).toBe('approved');

    const fetched = gate.getDecision(db, exec.id);
    expect(fetched?.id).toBe(decision.id);
  });

  it('returns undefined when no decision recorded', () => {
    expect(gate.getDecision(db, 'missing')).toBeUndefined();
  });

  it('rejects a second decision for the same stage execution', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const exec = seedStageExecution(db, run);

    gate.recordDecision(db, {
      stage_execution_id: exec.id,
      decided_by: 'a',
      decision: 'approved',
      feedback: null,
    });
    expect(() =>
      gate.recordDecision(db, {
        stage_execution_id: exec.id,
        decided_by: 'b',
        decision: 'rejected',
        feedback: 'no',
      }),
    ).toThrow();
  });
});
