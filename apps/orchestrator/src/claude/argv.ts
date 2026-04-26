/**
 * Pure builder that turns a stage agent config + prompt + working dir into a
 * fully-formed argv array suitable for `spawn('claude', argv, …)`.
 *
 * No I/O, no subprocess work — this lives here so it can be unit-tested
 * exhaustively and pinned by snapshots.
 */

import type { StageAgentConfig } from '@auto-finish/pipeline-schema';

/**
 * The complete invocation specification: argv array (first element is the
 * binary name), and optional env / cwd overrides for the subprocess.
 *
 * Note: `argv[0]` is the binary name (`'claude'`) — it is NOT a path. The
 * sandbox's `startStream` / `run` resolves it via PATH inside the sandbox.
 */
export interface ClaudeInvocation {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface BuildClaudeInvocationArgs {
  stageAgentConfig: StageAgentConfig;
  prompt: string;
  workingDir: string;
  /** Extra tools to merge with `stageAgentConfig.allowed_tools` (deduped). */
  extraAllowedTools?: string[];
  /** Overrides `stageAgentConfig.model` if provided. */
  model?: string;
  /** Extra env vars to forward to the subprocess. */
  env?: Record<string, string>;
}

/**
 * Build a `claude` CLI invocation.
 *
 * Argv assembly order is deterministic so snapshot tests are stable:
 *   1. binary name (`claude`)
 *   2. `--print --output-format stream-json --include-partial-messages --verbose`
 *      All four are required together: `--verbose` is mandatory in headless
 *      mode (`--print`) when streaming JSON, per real-capture findings.
 *   3. `--append-system-prompt <value>` (two-arg form: prompts can be long)
 *   4. `--allowedTools=A,B,C` IF the merged tool list is non-empty.
 *      MUST use `=` form with comma-joined values — the CLI parses
 *      space-separated lists differently and silently drops the others.
 *   5. `--model=<m>` if specified (override > stage config).
 *   6. `--add-dir=<dir>` repeated for each entry in `add_dirs`.
 *   7. `--max-turns=<n>` if specified.
 *   8. The user prompt as the final positional argument.
 *
 * Empty / missing optional inputs => the corresponding flag is OMITTED, not
 * emitted with an empty value. This keeps the CLI behavior unambiguous.
 */
export function buildClaudeInvocation(
  args: BuildClaudeInvocationArgs,
): ClaudeInvocation {
  const { stageAgentConfig, prompt, workingDir } = args;

  const argv: string[] = ['claude'];

  // (2) Always-on streaming flags.
  argv.push(
    '--print',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
  );

  // (3) System prompt — two-arg form because prompts can be many KB and we
  // want consistent argv encoding without a custom escape pass.
  argv.push('--append-system-prompt', stageAgentConfig.system_prompt);

  // (4) Allowed tools. MUST be `=` form with a single comma-joined value.
  // Space-separated lists (e.g. `--allowedTools Read Write`) are interpreted
  // by the CLI as flag + first value + extra positional args, silently
  // dropping all but the first tool.
  const mergedTools = dedupePreservingOrder([
    ...stageAgentConfig.allowed_tools,
    ...(args.extraAllowedTools ?? []),
  ]);
  if (mergedTools.length > 0) {
    argv.push(`--allowedTools=${mergedTools.join(',')}`);
  }

  // (5) Model override > stage default. Omitted entirely if neither is set.
  const model = args.model ?? stageAgentConfig.model;
  if (model !== undefined) {
    argv.push(`--model=${model}`);
  }

  // (6) add_dirs: each entry becomes its own --add-dir flag. We use the `=`
  // form for consistency with allowedTools/model (and to keep argv compact).
  const addDirs = stageAgentConfig.add_dirs ?? [];
  for (const dir of addDirs) {
    argv.push(`--add-dir=${dir}`);
  }

  // (7) Max turns safety cap.
  if (stageAgentConfig.max_turns !== undefined) {
    argv.push(`--max-turns=${String(stageAgentConfig.max_turns)}`);
  }

  // (8) User prompt as the final positional. Caller is responsible for any
  // template substitutions before passing it in.
  argv.push(prompt);

  const invocation: ClaudeInvocation = {
    argv,
    cwd: workingDir,
  };
  if (args.env !== undefined) {
    invocation.env = args.env;
  }
  return invocation;
}

/**
 * Deduplicate while preserving first-occurrence order. We avoid `new Set`
 * round-tripping because, while `Set` does preserve insertion order, the
 * explicit loop is clearer about the intent ("first wins").
 */
function dedupePreservingOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
