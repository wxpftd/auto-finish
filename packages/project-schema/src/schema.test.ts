import { describe, it, expect } from 'vitest';
import {
  ProjectConfigSchema,
  RepoConfigSchema,
  McpServerConfigSchema,
  isGitUrl,
} from './schema.js';

const baseRepo = {
  name: 'frontend',
  git_url: 'https://github.com/example/frontend.git',
  working_dir: '/workspace/frontend',
};

const baseProject = {
  id: 'example-app',
  name: 'Example App',
  repos: [baseRepo],
  sandbox_config: {
    provider: 'opensandbox',
  },
  claude_config: {
    credentials_source: 'host_mount',
  },
};

describe('ProjectConfigSchema', () => {
  it('accepts a minimal valid project and applies defaults', () => {
    const result = ProjectConfigSchema.safeParse(baseProject);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.id).toBe('example-app');
    expect(result.data.repos).toHaveLength(1);

    const first = result.data.repos[0]!;
    // default_branch default applied
    expect(first.default_branch).toBe('main');

    // claude_config.credentials_path default applied
    expect(result.data.claude_config.credentials_path).toBe(
      '~/.claude/.credentials.json',
    );
  });

  it('rejects missing required field (no repos key) with a path that mentions it', () => {
    const { repos: _repos, ...withoutRepos } = baseProject;
    const result = ProjectConfigSchema.safeParse(withoutRepos);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('repos');
  });

  it('rejects empty repos array', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      repos: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) => i.path.join('.') === 'repos'),
    ).toBe(true);
  });

  it('rejects bad git_url', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      repos: [{ ...baseRepo, git_url: 'not-a-url' }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find(
      (i) => i.path.join('.') === 'repos.0.git_url',
    );
    expect(issue).toBeDefined();
  });

  it('rejects two repos with the same name with a custom message', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      repos: [
        baseRepo,
        { ...baseRepo, working_dir: '/workspace/other' },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const dup = result.error.issues.find((i) =>
      i.message.includes('duplicate repo name'),
    );
    expect(dup).toBeDefined();
    expect(dup!.message).toContain('frontend');
    expect(dup!.path.join('.')).toBe('repos.1.name');
  });

  it('rejects two repos with the same working_dir with a custom message', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      repos: [
        baseRepo,
        { ...baseRepo, name: 'backend' },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const dup = result.error.issues.find((i) =>
      i.message.includes('duplicate repo working_dir'),
    );
    expect(dup).toBeDefined();
    expect(dup!.message).toContain('/workspace/frontend');
    expect(dup!.path.join('.')).toBe('repos.1.working_dir');
  });

  it('rejects non-absolute working_dir', () => {
    const result = RepoConfigSchema.safeParse({
      ...baseRepo,
      working_dir: 'workspace/frontend',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find(
      (i) => i.path.join('.') === 'working_dir',
    );
    expect(issue).toBeDefined();
    expect(issue!.message).toMatch(/absolute POSIX path/);
  });

  it('rejects unknown extra top-level keys (strict)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      surprise: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('warm_volume_backend defaults to "host" when unset (Phase 1.6 backwards-compat)', () => {
    const result = ProjectConfigSchema.safeParse(baseProject);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sandbox_config.warm_volume_backend).toBe('host');
  });

  it('warm_volume_backend accepts "pvc"', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      sandbox_config: {
        provider: 'opensandbox',
        warm_strategy: 'shared_volume',
        warm_volume_claim: 'proj-deps',
        warm_mount_path: '/workspace/.deps',
        warm_volume_backend: 'pvc',
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sandbox_config.warm_volume_backend).toBe('pvc');
  });

  it('warm_volume_backend accepts "ossfs" (schema-level; provider-level not yet impl)', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      sandbox_config: {
        provider: 'opensandbox',
        warm_strategy: 'shared_volume',
        warm_volume_claim: 'proj-deps',
        warm_mount_path: '/workspace/.deps',
        warm_volume_backend: 'ossfs',
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sandbox_config.warm_volume_backend).toBe('ossfs');
  });

  it('rejects unknown warm_volume_backend value with helpful enum message', () => {
    const result = ProjectConfigSchema.safeParse({
      ...baseProject,
      sandbox_config: {
        provider: 'opensandbox',
        warm_strategy: 'shared_volume',
        warm_volume_claim: 'proj-deps',
        warm_mount_path: '/workspace/.deps',
        warm_volume_backend: 'docker',
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) =>
      i.path.join('.') === 'sandbox_config.warm_volume_backend',
    );
    expect(issue).toBeDefined();
    // zod's enum error contains the union of valid options.
    expect(issue!.message).toMatch(/host|pvc|ossfs/);
  });
});

describe('isGitUrl', () => {
  it('accepts https with .git', () => {
    expect(isGitUrl('https://github.com/example/repo.git')).toBe(true);
  });

  it('accepts https without .git', () => {
    expect(isGitUrl('https://github.com/example/repo')).toBe(true);
  });

  it('accepts git@host:path.git form', () => {
    expect(isGitUrl('git@github.com:example/repo.git')).toBe(true);
  });

  it('accepts ssh://git@host/path form', () => {
    expect(isGitUrl('ssh://git@github.com/example/repo.git')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isGitUrl('not-a-url')).toBe(false);
    expect(isGitUrl('ftp://example.com/repo.git')).toBe(false);
    expect(isGitUrl('')).toBe(false);
  });
});

describe('McpServerConfigSchema', () => {
  it('accepts the command/stdio form', () => {
    const result = McpServerConfigSchema.safeParse({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts the url/remote form', () => {
    const result = McpServerConfigSchema.safeParse({
      url: 'https://mcp.example.com/sse',
      transport: 'sse',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an object missing both command and url', () => {
    const result = McpServerConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra keys on the command form', () => {
    const result = McpServerConfigSchema.safeParse({
      command: 'npx',
      surprise: true,
    });
    expect(result.success).toBe(false);
  });
});
