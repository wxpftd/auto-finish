import { describe, it, expect } from 'vitest';
import { reduceEvent, type EventViewState } from './event-reducer.js';
import type { PipelineEvent, StageExecution } from './types.js';

function baseState(overrides: Partial<EventViewState> = {}): EventViewState {
  return {
    log: [],
    liveStatus: 'running',
    currentStage: 'design',
    stages: [],
    ...overrides,
  };
}

describe('reduceEvent — cold_restart', () => {
  it('appends a timeline entry and leaves run status unchanged', () => {
    const stages: StageExecution[] = [
      {
        id: 'se-1',
        run_id: 'run-1',
        stage_name: 'design',
        status: 'running',
        claude_subprocess_pid: null,
        claude_session_id: null,
        started_at: 1_700_000_000_000,
        finished_at: null,
        events_json: [],
      },
    ];
    const before = baseState({
      liveStatus: 'running',
      currentStage: 'design',
      stages,
    });
    const ev: PipelineEvent = {
      kind: 'cold_restart',
      run_id: 'run-1',
      stage_name: 'design',
      at: '2026-04-26T12:00:00.000Z',
      reason: 'dep-install failure detected',
    };

    const after = reduceEvent(before, ev, 1_745_000_000_000);

    // Timeline gained an entry mentioning the stage and the reason.
    expect(after.log).toHaveLength(1);
    expect(after.log[0]?.line).toBe(
      'cold-restart at "design" — dep-install failure detected',
    );
    expect(after.log[0]?.at).toBe(1_745_000_000_000);

    // Run-status reducer treats cold_restart as a no-op — still running.
    expect(after.liveStatus).toBe('running');
    // currentStage and stages must not be mutated by a cold_restart.
    expect(after.currentStage).toBe('design');
    expect(after.stages).toBe(before.stages);
    // Input must not be mutated.
    expect(before.log).toHaveLength(0);
  });
});
