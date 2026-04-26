import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { parsePipelineYaml, type Pipeline } from '@auto-finish/pipeline-schema';

import {
  buildExecutionPlan,
  findNextStage,
  findStage,
} from './plan.js';

// Resolve the bundled example pipeline.yaml. We walk up to the workspace root
// from this test file rather than rely on cwd, so the test passes from any
// caller (vitest run, IDE, monorepo root).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXAMPLE_PIPELINE_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'pipeline-schema',
  'examples',
  'default-pipeline.yaml',
);

function loadDefaultPipeline(): Pipeline {
  const yaml = readFileSync(EXAMPLE_PIPELINE_PATH, 'utf8');
  return parsePipelineYaml(yaml);
}

/** Minimal pipeline factory for synthesized cases. */
function makePipeline(stages: Array<{ name: string; hasGate?: boolean }>): Pipeline {
  return {
    id: 'test',
    name: 'test pipeline',
    stages: stages.map(({ name, hasGate }) => ({
      name,
      agent_config: {
        system_prompt: 'p',
        allowed_tools: ['Read'],
      },
      artifacts: [],
      on_failure: 'pause',
      ...(hasGate
        ? {
            gate: {
              required: true,
              review_targets: [`.auto-finish/artifacts/${name}/x.md`],
            },
          }
        : {}),
    })),
  };
}

describe('buildExecutionPlan — bundled default pipeline', () => {
  const pipeline = loadDefaultPipeline();
  const plan = buildExecutionPlan(pipeline);

  it('reports pipeline metadata', () => {
    expect(plan.pipeline_id).toBe('default');
    expect(plan.pipeline_name).toBe('Default 4-stage pipeline');
  });

  it('has exactly 4 stages, in declared order', () => {
    expect(plan.total_stages).toBe(4);
    expect(plan.stages.map((s) => s.name)).toEqual([
      '需求分析',
      '方案设计',
      '实施',
      '验证',
    ]);
  });

  it('has gates at stages 2 and 4 only', () => {
    expect(plan.stages.map((s) => s.has_gate)).toEqual([
      false,
      true,
      false,
      true,
    ]);
    expect(plan.has_any_gate).toBe(true);
  });

  it('marks the last stage with is_last and assigns 0-based indices', () => {
    expect(plan.stages.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(plan.stages.map((s) => s.is_last)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('preserves gate review_targets verbatim on planned stages', () => {
    const designStage = plan.stages[1];
    expect(designStage?.gate?.review_targets).toEqual([
      '.auto-finish/artifacts/方案设计/design.md',
    ]);
  });
});

describe('findNextStage — traversal across the default pipeline', () => {
  const plan = buildExecutionPlan(loadDefaultPipeline());

  it('null current stage yields the first stage', () => {
    expect(findNextStage(plan, null)?.name).toBe('需求分析');
  });

  it('walks every stage in order, returning null at the end', () => {
    const visited: string[] = [];
    let current: string | null = null;
    while (true) {
      const next = findNextStage(plan, current);
      if (!next) break;
      visited.push(next.name);
      current = next.name;
    }
    expect(visited).toEqual(['需求分析', '方案设计', '实施', '验证']);
    expect(findNextStage(plan, '验证')).toBeNull();
  });

  it('returns null for a name not in the plan', () => {
    expect(findNextStage(plan, 'does-not-exist')).toBeNull();
  });
});

describe('findStage', () => {
  const plan = buildExecutionPlan(loadDefaultPipeline());

  it('returns the matching stage', () => {
    const s = findStage(plan, '方案设计');
    expect(s?.name).toBe('方案设计');
    expect(s?.has_gate).toBe(true);
  });

  it('returns null for a missing stage', () => {
    expect(findStage(plan, 'nope')).toBeNull();
  });
});

describe('buildExecutionPlan — edge cases', () => {
  it('single-stage pipeline marks that stage is_last and total_stages=1', () => {
    const plan = buildExecutionPlan(makePipeline([{ name: 'only' }]));
    expect(plan.total_stages).toBe(1);
    expect(plan.stages[0]?.is_last).toBe(true);
    expect(plan.has_any_gate).toBe(false);
    expect(findNextStage(plan, null)?.name).toBe('only');
    expect(findNextStage(plan, 'only')).toBeNull();
  });

  it('all-gates pipeline reports every stage as gated', () => {
    const plan = buildExecutionPlan(
      makePipeline([
        { name: 'a', hasGate: true },
        { name: 'b', hasGate: true },
        { name: 'c', hasGate: true },
      ]),
    );
    expect(plan.stages.every((s) => s.has_gate)).toBe(true);
    expect(plan.has_any_gate).toBe(true);
    expect(plan.stages[2]?.is_last).toBe(true);
  });

  it('throws on empty stages (defensive — schema would also reject)', () => {
    expect(() =>
      buildExecutionPlan({
        id: 'empty',
        name: 'empty',
        stages: [],
      } as unknown as Pipeline),
    ).toThrow(/no stages/);
  });

  it('throws on duplicate stage names (defensive — schema would also reject)', () => {
    expect(() =>
      buildExecutionPlan({
        id: 'dup',
        name: 'dup',
        stages: [
          {
            name: 'a',
            agent_config: { system_prompt: 'p', allowed_tools: [] },
            artifacts: [],
            on_failure: 'pause',
          },
          {
            name: 'a',
            agent_config: { system_prompt: 'p', allowed_tools: [] },
            artifacts: [],
            on_failure: 'pause',
          },
        ],
      } as unknown as Pipeline),
    ).toThrow(/duplicate stage name/);
  });
});
