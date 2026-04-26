import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePipelineYaml } from './parse.js';

const defaultPipelinePath = fileURLToPath(
  new URL('../examples/default-pipeline.yaml', import.meta.url),
);

const minimalYaml = `
id: p1
name: Pipeline 1
stages:
  - name: stage-1
    agent_config:
      system_prompt: do the thing
      allowed_tools:
        - Read
`;

describe('parsePipelineYaml', () => {
  it('parses a minimal valid YAML and applies defaults', () => {
    const pipeline = parsePipelineYaml(minimalYaml);
    expect(pipeline.id).toBe('p1');
    expect(pipeline.stages).toHaveLength(1);
    const first = pipeline.stages[0]!;
    expect(first.on_failure).toBe('pause');
    expect(first.artifacts).toEqual([]);
  });

  it('throws on malformed YAML', () => {
    const broken = 'id: p1\nname: x\nstages: [unterminated';
    expect(() => parsePipelineYaml(broken)).toThrow(
      /failed to parse YAML/,
    );
  });

  it('throws on empty document', () => {
    expect(() => parsePipelineYaml('')).toThrow(/empty/);
  });

  it('parses the bundled examples/default-pipeline.yaml successfully', () => {
    const yaml = readFileSync(defaultPipelinePath, 'utf-8');
    const pipeline = parsePipelineYaml(yaml);

    expect(pipeline.id).toBe('default');
    expect(pipeline.stages).toHaveLength(4);
    expect(pipeline.stages.map((s) => s.name)).toEqual([
      '需求分析',
      '方案设计',
      '实施',
      '验证',
    ]);

    // Two gates: after 方案设计 and after 验证.
    const gates = pipeline.stages.filter((s) => s.gate !== undefined);
    expect(gates).toHaveLength(2);
    expect(gates.map((s) => s.name)).toEqual(['方案设计', '验证']);

    // gate.review_targets must reference real artifact paths declared somewhere
    // in the pipeline (sanity check for the bundled default).
    const allArtifactPaths = new Set(
      pipeline.stages.flatMap((s) => s.artifacts.map((a) => a.path)),
    );
    for (const stage of gates) {
      for (const target of stage.gate!.review_targets) {
        expect(allArtifactPaths.has(target)).toBe(true);
      }
    }
  });

  it('parses a pipeline with 5+ stages', () => {
    const yaml = `
id: long
name: Long pipeline
stages:
  - name: s1
    agent_config: { system_prompt: a, allowed_tools: [Read] }
  - name: s2
    agent_config: { system_prompt: b, allowed_tools: [Read] }
  - name: s3
    agent_config: { system_prompt: c, allowed_tools: [Read] }
  - name: s4
    agent_config: { system_prompt: d, allowed_tools: [Read] }
  - name: s5
    agent_config: { system_prompt: e, allowed_tools: [Read] }
  - name: s6
    agent_config: { system_prompt: f, allowed_tools: [Read] }
`;
    const pipeline = parsePipelineYaml(yaml);
    expect(pipeline.stages).toHaveLength(6);
  });

  it('produces an error message that references the bad field path', () => {
    const yaml = `
id: p1
name: bad
stages:
  - name: stage-1
    agent_config:
      system_prompt: hi
      allowed_tools: [Read]
    on_failure: explode
`;
    let err: unknown;
    try {
      parsePipelineYaml(yaml);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/validation failed/);
    expect(msg).toContain('stages.0.on_failure');
  });

  it('reports duplicate stage name path', () => {
    const yaml = `
id: p1
name: dupes
stages:
  - name: same
    agent_config: { system_prompt: a, allowed_tools: [Read] }
  - name: same
    agent_config: { system_prompt: b, allowed_tools: [Read] }
`;
    expect(() => parsePipelineYaml(yaml)).toThrow(/duplicate stage name/);
  });
});
