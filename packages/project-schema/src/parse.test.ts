import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseProjectYaml } from './parse.js';

const defaultProjectPath = fileURLToPath(
  new URL('../examples/default-project.yaml', import.meta.url),
);

const minimalYaml = `
id: example-app
name: Example App
repos:
  - name: frontend
    git_url: https://github.com/example/frontend.git
    working_dir: /workspace/frontend
sandbox_config:
  provider: opensandbox
claude_config:
  credentials_source: host_mount
`;

describe('parseProjectYaml', () => {
  it('parses a minimal valid YAML and applies defaults', () => {
    const project = parseProjectYaml(minimalYaml);
    expect(project.id).toBe('example-app');
    expect(project.repos).toHaveLength(1);
    const first = project.repos[0]!;
    expect(first.default_branch).toBe('main');
    expect(project.claude_config.credentials_path).toBe(
      '~/.claude/.credentials.json',
    );
  });

  it('throws on malformed YAML', () => {
    const broken = 'id: x\nname: y\nrepos: [unterminated';
    expect(() => parseProjectYaml(broken)).toThrow(/failed to parse YAML/);
  });

  it('throws on empty document', () => {
    expect(() => parseProjectYaml('')).toThrow(/empty/);
  });

  it('throws on whitespace-only document', () => {
    expect(() => parseProjectYaml('   \n  \n')).toThrow(/empty/);
  });

  it('parses the bundled examples/default-project.yaml successfully', () => {
    const yaml = readFileSync(defaultProjectPath, 'utf-8');
    const project = parseProjectYaml(yaml);

    expect(project.id).toBe('example-app');
    expect(project.repos).toHaveLength(2);
    expect(project.repos.map((r) => r.name)).toEqual(['frontend', 'backend']);

    // Both repos must have unique working dirs.
    const dirs = project.repos.map((r) => r.working_dir);
    expect(new Set(dirs).size).toBe(dirs.length);

    expect(project.sandbox_config.provider).toBe('opensandbox');
    expect(project.sandbox_config.warm_strategy).toBe('baked_image');
    expect(project.sandbox_config.warm_image).toBe(
      'ghcr.io/example-org/example-app:warm',
    );
    expect(project.claude_config.credentials_source).toBe('host_mount');

    // allowed_tools narrowed to the patterns the spec calls for.
    const tools = project.claude_config.allowed_tools ?? [];
    expect(tools).toContain('Read');
    expect(tools).toContain('Bash(git:*)');
    expect(tools).toContain('Bash(npm:*)');
    expect(tools).toContain('Bash(pytest:*)');

    // default_pipeline_id matches the bundled pipeline-schema example id.
    expect(project.default_pipeline_id).toBe('default');
  });

  it('rejects unknown extra top-level keys (strict failure)', () => {
    const yaml = `${minimalYaml}\nsurprise: field\n`;
    expect(() => parseProjectYaml(yaml)).toThrow(/validation failed/);
  });

  it('produces an error message that references the bad field path', () => {
    const yaml = `
id: example-app
name: Example App
repos:
  - name: frontend
    git_url: not-a-url
    working_dir: /workspace/frontend
sandbox_config:
  provider: opensandbox
claude_config:
  credentials_source: host_mount
`;
    let err: unknown;
    try {
      parseProjectYaml(yaml);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/validation failed/);
    expect(msg).toContain('repos.0.git_url');
  });

  it('warm_volume_backend defaults to "host" when YAML omits it', () => {
    const project = parseProjectYaml(minimalYaml);
    expect(project.sandbox_config.warm_volume_backend).toBe('host');
  });

  it('reports duplicate repo name from the parsed YAML', () => {
    const yaml = `
id: example-app
name: Example App
repos:
  - name: frontend
    git_url: https://github.com/example/a.git
    working_dir: /workspace/a
  - name: frontend
    git_url: https://github.com/example/b.git
    working_dir: /workspace/b
sandbox_config:
  provider: opensandbox
claude_config:
  credentials_source: host_mount
`;
    expect(() => parseProjectYaml(yaml)).toThrow(/duplicate repo name/);
  });
});
