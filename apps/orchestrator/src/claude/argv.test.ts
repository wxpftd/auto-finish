import { describe, it, expect } from 'vitest';
import type { StageAgentConfig } from '@auto-finish/pipeline-schema';
import { buildClaudeInvocation } from './argv.js';

/**
 * Helper: minimal valid StageAgentConfig fixture. Tests override fields
 * explicitly so the snapshots show what each test exercises.
 */
function baseConfig(overrides: Partial<StageAgentConfig> = {}): StageAgentConfig {
  return {
    system_prompt: 'You are stage agent X.',
    allowed_tools: [],
    ...overrides,
  };
}

describe('buildClaudeInvocation', () => {
  it('always emits the four streaming flags and a final positional prompt', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig(),
      prompt: 'do the thing',
      workingDir: '/workspace',
    });

    // First arg is the binary name.
    expect(inv.argv[0]).toBe('claude');

    // Streaming flags must all be present together.
    expect(inv.argv).toContain('--print');
    expect(inv.argv).toContain('--output-format');
    expect(inv.argv).toContain('stream-json');
    expect(inv.argv).toContain('--include-partial-messages');
    expect(inv.argv).toContain('--verbose');

    // Last arg is the user prompt.
    expect(inv.argv.at(-1)).toBe('do the thing');

    // cwd flows through.
    expect(inv.cwd).toBe('/workspace');

    expect(inv.argv).toMatchInlineSnapshot(`
      [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--append-system-prompt",
        "You are stage agent X.",
        "do the thing",
      ]
    `);
  });

  it('OMITS --allowedTools when the merged list is empty (does not emit empty value)', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig({ allowed_tools: [] }),
      prompt: 'p',
      workingDir: '/w',
    });

    expect(inv.argv.some((a) => a.startsWith('--allowedTools'))).toBe(false);
  });

  it('encodes allowed_tools using = form, comma-joined, never space-separated', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig({
        allowed_tools: ['Read', 'Write', 'Edit', 'Bash(npm test:*)'],
      }),
      prompt: 'p',
      workingDir: '/w',
    });

    // The flag is a single argv entry of the form --allowedTools=A,B,C,D.
    const toolsFlag = inv.argv.find((a) => a.startsWith('--allowedTools'));
    expect(toolsFlag).toBe('--allowedTools=Read,Write,Edit,Bash(npm test:*)');

    // Defensive: no separate "Read", "Write" entries.
    expect(inv.argv).not.toContain('Read');
    expect(inv.argv).not.toContain('Write');

    expect(inv.argv).toMatchInlineSnapshot(`
      [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--append-system-prompt",
        "You are stage agent X.",
        "--allowedTools=Read,Write,Edit,Bash(npm test:*)",
        "p",
      ]
    `);
  });

  it('merges extraAllowedTools onto allowed_tools and deduplicates (first wins)', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig({ allowed_tools: ['Read', 'Write'] }),
      extraAllowedTools: ['Write', 'Edit'], // Write is dup; should appear once
      prompt: 'p',
      workingDir: '/w',
    });

    const toolsFlag = inv.argv.find((a) => a.startsWith('--allowedTools'));
    expect(toolsFlag).toBe('--allowedTools=Read,Write,Edit');
  });

  it('honors model override (args.model takes precedence over stage config)', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig({ model: 'sonnet-from-stage' }),
      model: 'opus-from-override',
      prompt: 'p',
      workingDir: '/w',
    });

    expect(inv.argv).toContain('--model=opus-from-override');
    expect(inv.argv).not.toContain('--model=sonnet-from-stage');
  });

  it('falls back to stageAgentConfig.model when no override is given', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig({ model: 'sonnet-from-stage' }),
      prompt: 'p',
      workingDir: '/w',
    });

    expect(inv.argv).toContain('--model=sonnet-from-stage');
  });

  it('emits one --add-dir per entry, in order', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig({
        add_dirs: ['/workspace/frontend', '/workspace/backend', '/workspace/.auto-finish'],
      }),
      prompt: 'p',
      workingDir: '/workspace',
    });

    const addDirFlags = inv.argv.filter((a) => a.startsWith('--add-dir='));
    expect(addDirFlags).toEqual([
      '--add-dir=/workspace/frontend',
      '--add-dir=/workspace/backend',
      '--add-dir=/workspace/.auto-finish',
    ]);
  });

  it('omits --add-dir entirely when add_dirs is missing', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig(),
      prompt: 'p',
      workingDir: '/w',
    });

    expect(inv.argv.some((a) => a.startsWith('--add-dir'))).toBe(false);
  });

  it('emits --max-turns when set, omits when not', () => {
    const withCap = buildClaudeInvocation({
      stageAgentConfig: baseConfig({ max_turns: 12 }),
      prompt: 'p',
      workingDir: '/w',
    });
    expect(withCap.argv).toContain('--max-turns=12');

    const withoutCap = buildClaudeInvocation({
      stageAgentConfig: baseConfig(),
      prompt: 'p',
      workingDir: '/w',
    });
    expect(withoutCap.argv.some((a) => a.startsWith('--max-turns'))).toBe(false);
  });

  it('passes the system prompt via --append-system-prompt as a TWO-arg pair', () => {
    const longPrompt =
      'You are an expert coding agent.\n\nFollow the constitution.\n'.repeat(20);
    const inv = buildClaudeInvocation({
      stageAgentConfig: baseConfig({ system_prompt: longPrompt }),
      prompt: 'p',
      workingDir: '/w',
    });

    // Two-arg form: flag and value are separate argv entries.
    const flagIdx = inv.argv.indexOf('--append-system-prompt');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(inv.argv[flagIdx + 1]).toBe(longPrompt);

    // No --append-system-prompt= entry.
    expect(inv.argv.some((a) => a.startsWith('--append-system-prompt='))).toBe(
      false,
    );
  });

  it('full snapshot: every field set together, deterministic argv order', () => {
    const inv = buildClaudeInvocation({
      stageAgentConfig: {
        system_prompt: 'SYS',
        allowed_tools: ['Read', 'Bash(npm test:*)'],
        model: 'stage-model',
        add_dirs: ['/workspace/frontend', '/workspace/backend'],
        max_turns: 8,
      },
      extraAllowedTools: ['Write'],
      model: 'override-model',
      prompt: 'implement /health endpoint',
      workingDir: '/workspace',
      env: { ANTHROPIC_BASE_URL: 'http://langfuse.proxy' },
    });

    expect(inv).toMatchInlineSnapshot(`
      {
        "argv": [
          "claude",
          "--print",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--append-system-prompt",
          "SYS",
          "--allowedTools=Read,Bash(npm test:*),Write",
          "--model=override-model",
          "--add-dir=/workspace/frontend",
          "--add-dir=/workspace/backend",
          "--max-turns=8",
          "implement /health endpoint",
        ],
        "cwd": "/workspace",
        "env": {
          "ANTHROPIC_BASE_URL": "http://langfuse.proxy",
        },
      }
    `);
  });
});
