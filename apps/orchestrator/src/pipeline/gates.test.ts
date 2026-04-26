import { describe, it, expect } from 'vitest';

import type { Pipeline, Stage } from '@auto-finish/pipeline-schema';

import { buildExecutionPlan } from './plan.js';
import {
  buildGateRequiredEvent,
  gateBlocksProgression,
  stageNeedsGate,
} from './gates.js';

function makeStage(opts: {
  name: string;
  gateRequired?: boolean;
  reviewTargets?: string[];
}): Stage {
  const stage: Stage = {
    name: opts.name,
    agent_config: { system_prompt: 'p', allowed_tools: ['Read'] },
    artifacts: [],
    on_failure: 'pause',
  };
  if (opts.gateRequired !== undefined) {
    stage.gate = {
      required: opts.gateRequired,
      review_targets: opts.reviewTargets ?? ['x.md'],
    };
  }
  return stage;
}

describe('stageNeedsGate', () => {
  it('returns false for stages without a gate', () => {
    expect(stageNeedsGate(makeStage({ name: 'a' }))).toBe(false);
  });

  it('returns true for stages with a required gate', () => {
    expect(
      stageNeedsGate(makeStage({ name: 'a', gateRequired: true })),
    ).toBe(true);
  });

  it('returns false when gate.required is false', () => {
    expect(
      stageNeedsGate(makeStage({ name: 'a', gateRequired: false })),
    ).toBe(false);
  });

  it('reads has_gate from a PlannedStage directly', () => {
    const pipeline: Pipeline = {
      id: 't',
      name: 't',
      stages: [
        makeStage({ name: 'one', gateRequired: true }),
        makeStage({ name: 'two' }),
      ],
    };
    const plan = buildExecutionPlan(pipeline);
    expect(stageNeedsGate(plan.stages[0]!)).toBe(true);
    expect(stageNeedsGate(plan.stages[1]!)).toBe(false);
  });
});

describe('gateBlocksProgression', () => {
  it('blocks on rejection', () => {
    expect(gateBlocksProgression('rejected')).toBe(true);
  });

  it('does not block on approval', () => {
    expect(gateBlocksProgression('approved')).toBe(false);
  });
});

describe('buildGateRequiredEvent', () => {
  const pipeline: Pipeline = {
    id: 't',
    name: 't',
    stages: [
      makeStage({
        name: '方案设计',
        gateRequired: true,
        reviewTargets: ['design.md', 'plan.md'],
      }),
      makeStage({ name: '实施' }),
    ],
  };
  const plan = buildExecutionPlan(pipeline);
  const T = '2026-04-26T12:00:00.000Z';

  it('builds a gate_required event for a gated stage', () => {
    const event = buildGateRequiredEvent({
      run_id: 'run-x',
      stage: plan.stages[0]!,
      at: T,
    });
    expect(event).toEqual({
      kind: 'gate_required',
      run_id: 'run-x',
      stage_name: '方案设计',
      review_targets: ['design.md', 'plan.md'],
      at: T,
    });
  });

  it('copies review_targets (not aliases the stage array)', () => {
    const stage = plan.stages[0]!;
    const event = buildGateRequiredEvent({ run_id: 'run-x', stage, at: T });
    expect(event.review_targets).not.toBe(stage.gate?.review_targets);
  });

  it('throws when called on a stage without a gate', () => {
    expect(() =>
      buildGateRequiredEvent({ run_id: 'r', stage: plan.stages[1]!, at: T }),
    ).toThrow(/no gate/);
  });
});
