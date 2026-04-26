import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from '../client.js';
import type { Db } from '../client.js';
import * as stage from './stage_executions.js';
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

describe('stage_executions repository', () => {
  it('creates a stage execution with empty events_json by default', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const exec = stage.createStageExecution(db, {
      run_id: run.id,
      stage_name: 'analyze',
      status: 'running',
      claude_subprocess_pid: 4242,
      claude_session_id: 'sess-1',
    });
    expect(exec.events_json).toEqual([]);
    expect(exec.claude_subprocess_pid).toBe(4242);
  });

  it('appends events atomically and preserves order', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const exec = seedStageExecution(db, run);

    stage.appendEvent(db, exec.id, { type: 'spawn', ts: 1, pid: 100 });
    stage.appendEvent(db, exec.id, {
      type: 'system_init',
      ts: 2,
      session_id: 'abc',
    });
    const after = stage.appendEvent(db, exec.id, {
      type: 'finish',
      ts: 3,
      ok: true,
    });
    expect(after.events_json).toHaveLength(3);
    expect(after.events_json.map((e) => e.type)).toEqual([
      'spawn',
      'system_init',
      'finish',
    ]);

    const fetched = stage.getStageExecution(db, exec.id);
    expect(fetched?.events_json).toHaveLength(3);
  });

  it('appendEvent throws for unknown id', () => {
    expect(() =>
      stage.appendEvent(db, 'missing', { type: 'x', ts: 1 }),
    ).toThrow();
  });

  it('finishStageExecution sets status and finished_at', () => {
    const project = seedProject(db);
    const pipeline = seedPipeline(db);
    const req = seedRequirement(db, project, pipeline);
    const run = seedRun(db, req, pipeline);
    const exec = seedStageExecution(db, run);

    const finished = stage.finishStageExecution(db, exec.id, {
      status: 'succeeded',
      finished_at: 12345,
    });
    expect(finished?.status).toBe('succeeded');
    expect(finished?.finished_at).toBe(12345);
  });

  describe('setClaudeSession', () => {
    it('lifts the claude session id into the row', () => {
      const project = seedProject(db);
      const pipeline = seedPipeline(db);
      const req = seedRequirement(db, project, pipeline);
      const run = seedRun(db, req, pipeline);
      const exec = seedStageExecution(db, run);

      const updated = stage.setClaudeSession(db, exec.id, {
        claude_session_id: 'sess-abc-123',
      });
      expect(updated?.claude_session_id).toBe('sess-abc-123');
      expect(updated?.claude_subprocess_pid).toBeNull();

      const fetched = stage.getStageExecution(db, exec.id);
      expect(fetched?.claude_session_id).toBe('sess-abc-123');
    });

    it('writes both session id and subprocess pid when both provided', () => {
      const project = seedProject(db);
      const pipeline = seedPipeline(db);
      const req = seedRequirement(db, project, pipeline);
      const run = seedRun(db, req, pipeline);
      const exec = seedStageExecution(db, run);

      const updated = stage.setClaudeSession(db, exec.id, {
        claude_session_id: 'sess-xyz',
        claude_subprocess_pid: 9999,
      });
      expect(updated?.claude_session_id).toBe('sess-xyz');
      expect(updated?.claude_subprocess_pid).toBe(9999);
    });

    it('returns the current row unchanged when no fields are provided', () => {
      const project = seedProject(db);
      const pipeline = seedPipeline(db);
      const req = seedRequirement(db, project, pipeline);
      const run = seedRun(db, req, pipeline);
      const exec = seedStageExecution(db, run);

      const result = stage.setClaudeSession(db, exec.id, {});
      expect(result?.id).toBe(exec.id);
      expect(result?.claude_session_id).toBeNull();
    });

    it('returns undefined for an unknown id', () => {
      expect(
        stage.setClaudeSession(db, 'missing', {
          claude_session_id: 'x',
        }),
      ).toBeUndefined();
    });
  });
});
