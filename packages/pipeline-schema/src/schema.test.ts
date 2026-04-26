import { describe, it, expect } from 'vitest';
import { PipelineSchema, StageSchema } from './schema.js';

const baseStage = {
  name: 'stage-1',
  agent_config: {
    system_prompt: 'do the thing',
    allowed_tools: ['Read'],
  },
};

describe('PipelineSchema', () => {
  it('accepts a minimal valid pipeline', () => {
    const result = PipelineSchema.safeParse({
      id: 'p1',
      name: 'Pipeline 1',
      stages: [baseStage],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.stages).toHaveLength(1);
    const first = result.data.stages[0]!;
    // defaults applied
    expect(first.on_failure).toBe('pause');
    expect(first.artifacts).toEqual([]);
  });

  it('rejects missing required fields', () => {
    const result = PipelineSchema.safeParse({
      // id missing
      name: 'no id',
      stages: [baseStage],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('id');
  });

  it('rejects an empty stages array', () => {
    const result = PipelineSchema.safeParse({
      id: 'p1',
      name: 'empty',
      stages: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join('.') === 'stages')).toBe(
      true,
    );
  });

  it('rejects duplicate stage names', () => {
    const result = PipelineSchema.safeParse({
      id: 'p1',
      name: 'dupes',
      stages: [baseStage, { ...baseStage }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const dup = result.error.issues.find((i) =>
      i.message.includes('duplicate stage name'),
    );
    expect(dup).toBeDefined();
    expect(dup!.path.join('.')).toBe('stages.1.name');
  });

  it('rejects an invalid on_failure value', () => {
    const result = StageSchema.safeParse({
      ...baseStage,
      on_failure: 'explode',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find(
      (i) => i.path.join('.') === 'on_failure',
    );
    expect(issue).toBeDefined();
  });

  it('applies artifact.required default of true', () => {
    const result = StageSchema.safeParse({
      ...baseStage,
      artifacts: [
        {
          path: 'a/b.md',
          type: 'markdown',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const artifact = result.data.artifacts[0]!;
    expect(artifact.required).toBe(true);
  });

  it('rejects unknown extra keys (strict)', () => {
    const result = PipelineSchema.safeParse({
      id: 'p1',
      name: 'extra',
      stages: [baseStage],
      surprise: 'field',
    });
    expect(result.success).toBe(false);
  });
});
