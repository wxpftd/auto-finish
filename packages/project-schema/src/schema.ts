import { z } from 'zod';

/**
 * Slug pattern used for project ids and repo names. Lowercase ASCII, must
 * start with a letter, can contain digits, hyphens and underscores after.
 *
 * (The task description mentioned "ULID-ish or matches this regex"; ULIDs are
 * uppercase Crockford base32 which would not match a lowercase pattern, so we
 * standardize on the slug form here.)
 */
const SLUG_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Accepts the four common git URL forms used in practice:
 *   - https://host/path.git
 *   - https://host/path           (no .git suffix)
 *   - git@host:owner/repo.git
 *   - ssh://git@host/path[.git]
 *
 * We deliberately keep this loose; the SandboxProvider performs the actual
 * clone and will surface real connectivity / auth errors.
 */
const GIT_URL_RE =
  /^(?:https:\/\/[^\s]+|git@[^\s:]+:[^\s]+\.git|ssh:\/\/git@[^\s/]+\/[^\s]+)$/;

/**
 * Returns true when `value` looks like a supported git URL.
 *
 * Exported for tests and for any future schema that wants to reuse the rule.
 */
export function isGitUrl(value: string): boolean {
  return GIT_URL_RE.test(value);
}

/**
 * Sandbox provider selection. `local` is a fallback raw-Docker path; the
 * default and remote modes both go through Daytona; `e2b` and `microsandbox`
 * are alternative single-binary backends behind the same SandboxProvider
 * interface.
 */
export const SandboxProviderSchema = z.enum([
  'local',
  'daytona',
  'e2b',
  'microsandbox',
]);

export type SandboxProviderKind = z.infer<typeof SandboxProviderSchema>;

/**
 * Sandbox configuration for a project. Applied when the orchestrator creates
 * a sandbox session for a Requirement run.
 */
export const SandboxConfigSchema = z
  .object({
    provider: SandboxProviderSchema.describe(
      'Which SandboxProvider implementation to use.',
    ),
    daytona_endpoint: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Daytona server URL; only consulted when provider === "daytona". ' +
          'Falls back to the orchestrator-level default.',
      ),
    image: z
      .string()
      .min(1)
      .optional()
      .describe('Container image used to back the sandbox.'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables exported inside the sandbox.'),
    setup_commands: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Shell snippets executed inside the sandbox at create time, after ' +
          'repo clones but before the first stage runs.',
      ),
  })
  .strict();

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/**
 * Where Claude Code credentials come from when the orchestrator launches the
 * `claude` CLI inside a sandbox.
 */
export const CredentialsSourceSchema = z.enum([
  'host_mount',
  'secret_manager',
]);

export type CredentialsSource = z.infer<typeof CredentialsSourceSchema>;

/**
 * MCP server configuration. Two transport shapes are accepted:
 *   - stdio (subprocess)   → { command, args?, env? }
 *   - remote (sse / http)  → { url, transport? }
 *
 * They have no shared discriminator key, so this is a plain union (not a
 * `z.discriminatedUnion`) — `safeParse` on `{}` falls through both branches
 * and fails, which is what we want.
 */
export const McpServerConfigSchema = z.union([
  z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      url: z.string().url(),
      transport: z.enum(['sse', 'http']).optional(),
    })
    .strict(),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Claude Code agent runtime configuration injected into every stage's CLI
 * subprocess. Stage-level `allowed_tools` may override or extend this list.
 */
export const ClaudeConfigSchema = z
  .object({
    credentials_source: CredentialsSourceSchema.describe(
      'Where to source ~/.claude/.credentials.json from.',
    ),
    credentials_path: z
      .string()
      .min(1)
      .default('~/.claude/.credentials.json')
      .describe(
        'Host-side path to the Claude Code credentials file. Used when ' +
          'credentials_source === "host_mount".',
      ),
    allowed_tools: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Project-level allowed tools list; stages may extend or override.',
      ),
    mcp_servers: z
      .record(z.string().min(1), McpServerConfigSchema)
      .optional()
      .describe('Named MCP servers exposed to claude inside the sandbox.'),
  })
  .strict();

export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;

/**
 * One repo within a Project. The orchestrator clones every Repo into the
 * sandbox at startup and creates a per-Requirement branch on each.
 */
export const RepoConfigSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        SLUG_RE,
        'repo name must be lowercase, start with a letter, and contain only [a-z0-9_-]',
      )
      .describe('Slug-style repo name; must be unique within a project.'),
    git_url: z
      .string()
      .min(1)
      .refine(isGitUrl, {
        message:
          'git_url must be one of: https://host/path[.git], git@host:path.git, ssh://git@host/path',
      })
      .describe('Git URL used to clone the repo into the sandbox.'),
    default_branch: z
      .string()
      .min(1)
      .default('main')
      .describe('Branch to base per-Requirement work branches from.'),
    working_dir: z
      .string()
      .min(1)
      .refine((p) => p.startsWith('/'), {
        message: 'working_dir must be an absolute POSIX path starting with "/"',
      })
      .describe('Sandbox-relative absolute path where the repo is mounted.'),
    test_command: z
      .string()
      .min(1)
      .optional()
      .describe('Optional per-repo verification command.'),
    pr_template: z
      .string()
      .min(1)
      .optional()
      .describe('Optional per-repo PR description template.'),
  })
  .strict();

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/**
 * Top-level project definition. Drives sandbox creation and multi-repo
 * scheduling for every Requirement bound to this project.
 *
 * Constraints enforced via superRefine:
 *  - `repos` non-empty (also enforced by `.min(1)` for an early message).
 *  - `repos[].name` unique within the project.
 *  - `repos[].working_dir` unique within the project (no two repos sharing
 *    a mount path).
 */
export const ProjectConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        SLUG_RE,
        'project id must be lowercase, start with a letter, and contain only [a-z0-9_-]',
      ),
    name: z.string().min(1),
    description: z.string().optional(),
    repos: z
      .array(RepoConfigSchema)
      .min(1, 'project must declare at least one repo'),
    default_pipeline_id: z
      .string()
      .min(1)
      .optional()
      .describe('id of the bundled pipeline.yaml this project defaults to.'),
    sandbox_config: SandboxConfigSchema,
    claude_config: ClaudeConfigSchema,
  })
  .strict()
  .superRefine((project, ctx) => {
    const seenName = new Map<string, number>();
    const seenDir = new Map<string, number>();

    project.repos.forEach((repo, index) => {
      const firstNameIdx = seenName.get(repo.name);
      if (firstNameIdx !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repos', index, 'name'],
          message: `duplicate repo name: "${repo.name}" (also at repos[${firstNameIdx}])`,
        });
      } else {
        seenName.set(repo.name, index);
      }

      const firstDirIdx = seenDir.get(repo.working_dir);
      if (firstDirIdx !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repos', index, 'working_dir'],
          message: `duplicate repo working_dir: "${repo.working_dir}" (also at repos[${firstDirIdx}])`,
        });
      } else {
        seenDir.set(repo.working_dir, index);
      }
    });
  });

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
