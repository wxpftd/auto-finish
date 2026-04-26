import { describe, it, expect } from 'vitest';

import type { PipelineEvent } from './events.js';
import {
  INITIAL_RUN_STATUS,
  reduceRunStatus,
  type RunStatus,
} from './state.js';

const RUN = 'run-1';
const REQ = 'req-1';
const T = '2026-04-26T00:00:00Z';

const ev = {
  runStarted: (): PipelineEvent => ({
    kind: 'run_started',
    run_id: RUN,
    requirement_id: REQ,
    at: T,
  }),
  stageStarted: (stage_name: string): PipelineEvent => ({
    kind: 'stage_started',
    run_id: RUN,
    stage_name,
    at: T,
  }),
  artifact: (stage_name: string, p: string): PipelineEvent => ({
    kind: 'stage_artifact_produced',
    run_id: RUN,
    stage_name,
    artifact_path: p,
  }),
  stageCompleted: (stage_name: string): PipelineEvent => ({
    kind: 'stage_completed',
    run_id: RUN,
    stage_name,
    at: T,
    duration_ms: 1234,
  }),
  stageFailed: (stage_name: string, error: string): PipelineEvent => ({
    kind: 'stage_failed',
    run_id: RUN,
    stage_name,
    at: T,
    error,
  }),
  gateRequired: (stage_name: string): PipelineEvent => ({
    kind: 'gate_required',
    run_id: RUN,
    stage_name,
    review_targets: ['a.md'],
    at: T,
  }),
  gateApproved: (stage_name: string): PipelineEvent => ({
    kind: 'gate_decided',
    run_id: RUN,
    stage_name,
    decision: 'approved',
  }),
  gateRejected: (stage_name: string): PipelineEvent => ({
    kind: 'gate_decided',
    run_id: RUN,
    stage_name,
    decision: 'rejected',
    feedback: 'fix it',
  }),
  runCompleted: (): PipelineEvent => ({
    kind: 'run_completed',
    run_id: RUN,
    at: T,
  }),
  runFailed: (error: string): PipelineEvent => ({
    kind: 'run_failed',
    run_id: RUN,
    at: T,
    error,
  }),
  runPaused: (reason: string): PipelineEvent => ({
    kind: 'run_paused',
    run_id: RUN,
    at: T,
    reason,
  }),
};

/** Apply a list of events in order to the initial status. */
function play(events: PipelineEvent[], start: RunStatus = INITIAL_RUN_STATUS) {
  return events.reduce(reduceRunStatus, start);
}

describe('reduceRunStatus — initial state', () => {
  it('starts in queued', () => {
    expect(INITIAL_RUN_STATUS).toEqual({ kind: 'queued' });
  });

  it('run_started while queued is a no-op (waiting on stage_started)', () => {
    expect(reduceRunStatus(INITIAL_RUN_STATUS, ev.runStarted())).toEqual({
      kind: 'queued',
    });
  });
});

describe('reduceRunStatus — happy path with gate approval', () => {
  it('queued -> running -> awaiting_gate -> running -> completed', () => {
    let s: RunStatus = INITIAL_RUN_STATUS;

    s = reduceRunStatus(s, ev.runStarted());
    expect(s.kind).toBe('queued');

    s = reduceRunStatus(s, ev.stageStarted('需求分析'));
    expect(s).toEqual({ kind: 'running', stage_name: '需求分析' });

    s = reduceRunStatus(s, ev.stageCompleted('需求分析'));
    expect(s).toEqual({ kind: 'running', stage_name: '需求分析' });

    s = reduceRunStatus(s, ev.stageStarted('方案设计'));
    expect(s).toEqual({ kind: 'running', stage_name: '方案设计' });

    s = reduceRunStatus(s, ev.artifact('方案设计', 'design.md'));
    // artifact never changes status
    expect(s).toEqual({ kind: 'running', stage_name: '方案设计' });

    s = reduceRunStatus(s, ev.gateRequired('方案设计'));
    expect(s).toEqual({ kind: 'awaiting_gate', stage_name: '方案设计' });

    s = reduceRunStatus(s, ev.gateApproved('方案设计'));
    expect(s).toEqual({ kind: 'running', stage_name: '方案设计' });

    s = reduceRunStatus(s, ev.stageStarted('实施'));
    expect(s).toEqual({ kind: 'running', stage_name: '实施' });

    s = reduceRunStatus(s, ev.stageCompleted('实施'));
    s = reduceRunStatus(s, ev.runCompleted());
    expect(s).toEqual({ kind: 'completed' });
  });
});

describe('reduceRunStatus — rejection forces rework', () => {
  it('awaiting_gate + rejected -> awaiting_changes; new stage_started resumes', () => {
    const s = play([
      ev.runStarted(),
      ev.stageStarted('方案设计'),
      ev.gateRequired('方案设计'),
      ev.gateRejected('方案设计'),
    ]);
    expect(s).toEqual({ kind: 'awaiting_changes', stage_name: '方案设计' });

    const s2 = reduceRunStatus(s, ev.stageStarted('方案设计'));
    expect(s2).toEqual({ kind: 'running', stage_name: '方案设计' });
  });

  it('approved + rejected events out of order while running are ignored', () => {
    const s = play([
      ev.runStarted(),
      ev.stageStarted('实施'),
      ev.gateApproved('实施'), // no gate is pending; should be no-op
    ]);
    expect(s).toEqual({ kind: 'running', stage_name: '实施' });
  });
});

describe('reduceRunStatus — failure paths', () => {
  it('running -> paused (recoverable) -> running -> completed', () => {
    let s = play([ev.runStarted(), ev.stageStarted('实施')]);
    s = reduceRunStatus(s, ev.stageFailed('实施', 'tests failed'));
    expect(s).toEqual({ kind: 'paused', reason: 'tests failed' });

    // resume on retry: a new stage_started moves us back to running
    s = reduceRunStatus(s, ev.stageStarted('实施'));
    expect(s).toEqual({ kind: 'running', stage_name: '实施' });

    s = reduceRunStatus(s, ev.runCompleted());
    expect(s).toEqual({ kind: 'completed' });
  });

  it('running -> failed (terminal) absorbs further events', () => {
    const s = play([
      ev.runStarted(),
      ev.stageStarted('实施'),
      ev.runFailed('aborted'),
    ]);
    expect(s).toEqual({ kind: 'failed', error: 'aborted' });

    // Terminal: nothing changes it.
    expect(reduceRunStatus(s, ev.stageStarted('next'))).toEqual(s);
    expect(reduceRunStatus(s, ev.runCompleted())).toEqual(s);
    expect(reduceRunStatus(s, ev.runPaused('whatever'))).toEqual(s);
    expect(reduceRunStatus(s, ev.gateRequired('实施'))).toEqual(s);
  });

  it('running + run_paused enters paused with operator reason', () => {
    const s = play([
      ev.runStarted(),
      ev.stageStarted('实施'),
      ev.runPaused('quota exhausted'),
    ]);
    expect(s).toEqual({ kind: 'paused', reason: 'quota exhausted' });
  });

  it('completed is terminal and absorbs further events', () => {
    const s = play([
      ev.runStarted(),
      ev.stageStarted('实施'),
      ev.runCompleted(),
    ]);
    expect(s).toEqual({ kind: 'completed' });
    expect(reduceRunStatus(s, ev.runFailed('boom'))).toEqual(s);
    expect(reduceRunStatus(s, ev.stageFailed('实施', 'x'))).toEqual(s);
  });
});

describe('reduceRunStatus — idempotency', () => {
  it('re-applying the same event yields the same state (every state)', () => {
    const samples: Array<{ status: RunStatus; event: PipelineEvent }> = [
      { status: { kind: 'queued' }, event: ev.runStarted() },
      {
        status: { kind: 'running', stage_name: '实施' },
        event: ev.stageCompleted('实施'),
      },
      {
        status: { kind: 'running', stage_name: '实施' },
        event: ev.artifact('实施', 'a.md'),
      },
      {
        status: { kind: 'awaiting_gate', stage_name: '方案设计' },
        event: ev.gateRequired('方案设计'),
      },
      {
        status: { kind: 'awaiting_changes', stage_name: '方案设计' },
        event: ev.gateRejected('方案设计'),
      },
      {
        status: { kind: 'paused', reason: 'x' },
        event: ev.runPaused('x'),
      },
      {
        status: { kind: 'completed' },
        event: ev.runCompleted(),
      },
      {
        status: { kind: 'failed', error: 'e' },
        event: ev.runFailed('e'),
      },
    ];

    for (const { status, event } of samples) {
      const once = reduceRunStatus(status, event);
      const twice = reduceRunStatus(once, event);
      expect(twice).toEqual(once);
    }
  });
});

describe('reduceRunStatus — corner cases & replay safety', () => {
  it('stage_completed while awaiting_gate is a no-op (cannot leave gate)', () => {
    const s: RunStatus = { kind: 'awaiting_gate', stage_name: '方案设计' };
    const next = reduceRunStatus(s, ev.stageCompleted('方案设计'));
    expect(next).toEqual(s);
  });

  it('stage_started while awaiting_gate is a no-op (defensive)', () => {
    const s: RunStatus = { kind: 'awaiting_gate', stage_name: '方案设计' };
    const next = reduceRunStatus(s, ev.stageStarted('实施'));
    expect(next).toEqual(s);
  });

  it('gate_required from queued is ignored (no stage running)', () => {
    const s: RunStatus = { kind: 'queued' };
    const next = reduceRunStatus(s, ev.gateRequired('方案设计'));
    expect(next).toEqual(s);
  });

  it('gate_decided while not awaiting_gate is ignored', () => {
    const s: RunStatus = { kind: 'running', stage_name: '实施' };
    expect(reduceRunStatus(s, ev.gateApproved('实施'))).toEqual(s);
    expect(reduceRunStatus(s, ev.gateRejected('实施'))).toEqual(s);
  });

  it('stage_failed while paused does not change the reason', () => {
    const s: RunStatus = { kind: 'paused', reason: 'orig' };
    const next = reduceRunStatus(s, ev.stageFailed('实施', 'new'));
    expect(next).toEqual(s);
  });

  it('artifact event never changes any status', () => {
    const cases: RunStatus[] = [
      { kind: 'queued' },
      { kind: 'running', stage_name: 'x' },
      { kind: 'awaiting_gate', stage_name: 'x' },
      { kind: 'awaiting_changes', stage_name: 'x' },
      { kind: 'paused', reason: 'x' },
      { kind: 'completed' },
      { kind: 'failed', error: 'x' },
    ];
    for (const s of cases) {
      expect(reduceRunStatus(s, ev.artifact('x', 'p'))).toEqual(s);
    }
  });
});
