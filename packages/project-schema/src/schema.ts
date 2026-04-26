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
 * Sandbox provider selection. `opensandbox` is the production default
 * (Apache 2.0 / CNCF — see decision 2 in the plan). `in_memory` is the
 * test reference implementation.
 */
export const SandboxProviderSchema = z.enum(['opensandbox', 'in_memory']);

export type SandboxProviderKind = z.infer<typeof SandboxProviderSchema>;

/**
 * Strategy for warm-starting a sandbox so the agent doesn't pay clone+install
 * cost on every Requirement (decision 4 in the plan).
 *
 *   - `baked_image`     — per-project Docker image with code + deps baked in
 *   - `shared_volume`   — fresh container, deps mounted from a Docker named
 *                          volume / PVC declared via OpenSandbox `volumes[]`
 *   - `cold_only`       — every run does a full clone + install (slow but
 *                          always works; useful for first-time onboarding)
 */
export const WarmStrategySchema = z.enum([
  'baked_image',
  'shared_volume',
  'cold_only',
]);

export type WarmStrategy = z.infer<typeof WarmStrategySchema>;

/**
 * Sandbox configuration for a project. Applied when the orchestrator creates
 * a sandbox session for a Requirement run.
 */
export const SandboxConfigSchema = z
  .object({
    provider: SandboxProviderSchema.default('opensandbox').describe(
      'Which SandboxProvider implementation to use; defaults to opensandbox.',
    ),
    endpoint: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Sandbox server URL (provider-specific). For opensandbox this is ' +
          'the sandbox-server FastAPI base URL. Falls back to the ' +
          'orchestrator-level default.',
      ),
    image: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Container image used to back the sandbox. When warm_strategy is ' +
          '"baked_image", prefer warm_image / base_image instead — image is ' +
          'ignored in that case.',
      ),
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
    warm_strategy: WarmStrategySchema.default('cold_only').describe(
      'Warm-start strategy; see decision 4 in the plan. Default is "cold_only" ' +
        'so unconfigured projects work out of the box (slow but always valid). ' +
        '"baked_image" is the *recommended* production strategy — opt in by ' +
        'setting warm_strategy="baked_image" + warm_image + base_image.',
    ),
    warm_image: z
      .string()
      .min(1)
      .optional()
      .describe(
        'warm_strategy="baked_image": the warm image tag containing code + ' +
          'deps + build cache (e.g. auto-finish/<project-id>:warm).',
      ),
    base_image: z
      .string()
      .min(1)
      .optional()
      .describe(
        'warm_strategy="baked_image": the cold-restart base image (runtime ' +
          'only, no deps). Used by Tier 2 fallback when an in-flight stage ' +
          'fails to install deps against the warm image.',
      ),
    warm_volume_claim: z
      .string()
      .min(1)
      .optional()
      .describe(
        'warm_strategy="shared_volume": Docker named volume name or PVC ' +
          'claimName holding deps (node_modules / .venv / etc.).',
      ),
    warm_mount_path: z
      .string()
      .min(1)
      .optional()
      .refine((p) => p === undefined || p.startsWith('/'), {
        message: 'warm_mount_path must be an absolute POSIX path starting with "/"',
      })
      .describe(
        'warm_strategy="shared_volume": absolute path inside the sandbox ' +
          'where the warm volume mounts (e.g. /workspace/.deps).',
      ),
    warm_volume_backend: z
      .enum(['host', 'pvc', 'ossfs'])
      .default('host')
      .describe(
        'shared_volume backend selector (OSEP-0003): "host" = docker named ' +
          'volume / 本机绝对路径; "pvc" = K8s PersistentVolumeClaim ' +
          '(claimName 复用 warm_volume_claim); "ossfs" = Aliyun OSS bucket ' +
          '(Phase 1.6 暂不实现，provider 会抛 not yet implemented). ' +
          '只对 OpenSandboxProvider 生效；其他 provider 忽略 volumes 字段。',
      ),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Cross-field consistency: baked_image needs warm_image; shared_volume
    // needs both warm_volume_claim and warm_mount_path. We accept missing
    // fields silently for cold_only since nothing extra is needed.
    if (cfg.warm_strategy === 'baked_image' && cfg.warm_image === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warm_image'],
        message:
          'warm_image is required when warm_strategy="baked_image" (see decision 4)',
      });
    }
    if (cfg.warm_strategy === 'shared_volume') {
      if (cfg.warm_volume_claim === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['warm_volume_claim'],
          message:
            'warm_volume_claim is required when warm_strategy="shared_volume"',
        });
      }
      if (cfg.warm_mount_path === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['warm_mount_path'],
          message:
            'warm_mount_path is required when warm_strategy="shared_volume"',
        });
      }
    }
  });

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
