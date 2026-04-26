import { z } from 'zod';

/**
 * Artifact a stage is expected to produce, e.g. a PRD markdown or a diff.
 * The orchestrator uses this schema to verify a stage's outputs and to
 * surface previews / gate review targets in the dashboard.
 */
export const ArtifactSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Sandbox-relative artifact path, typically under .auto-finish/artifacts/<stage>/',
      ),
    type: z
      .enum(['markdown', 'json', 'diff', 'text', 'directory'])
      .describe('Artifact MIME-ish type used for dashboard preview rendering.'),
    description: z.string().optional(),
    required: z
      .boolean()
      .default(true)
      .describe(
        'Whether the stage must produce this artifact to be considered successful.',
      ),
  })
  .strict();

export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * Human gate that blocks pipeline progress until an operator approves.
 * `review_targets` are artifact paths (matching some `Artifact.path`) that
 * the dashboard should surface in the review UI.
 */
export const GateSchema = z
  .object({
    required: z
      .boolean()
      .describe('If true, the pipeline pauses until a human approves.'),
    review_targets: z
      .array(z.string().min(1))
      .describe('Artifact paths to surface for human review.'),
  })
  .strict();

export type Gate = z.infer<typeof GateSchema>;

/**
 * Configuration used by the orchestrator to spawn a `claude` CLI subprocess
 * for a stage. Field names mirror Claude Code CLI flags.
 */
export const StageAgentConfigSchema = z
  .object({
    system_prompt: z
      .string()
      .min(1)
      .describe('Appended via --append-system-prompt to the claude CLI call.'),
    allowed_tools: z
      .array(z.string().min(1))
      .describe('Forwarded to --allowedTools (e.g. "Read", "Bash(npm test:*)").'),
    model: z
      .string()
      .min(1)
      .optional()
      .describe('Optional model override forwarded to --model.'),
    add_dirs: z
      .array(z.string().min(1))
      .optional()
      .describe('Extra directories the agent can see, forwarded to --add-dir.'),
    max_turns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional safety cap on agent turns for this stage.'),
  })
  .strict();

export type StageAgentConfig = z.infer<typeof StageAgentConfigSchema>;

/**
 * Per-stage failure policy.
 *
 *   - `retry`         — re-run the stage once (not yet implemented; treated
 *                        like `abort` until the retry path lands).
 *   - `pause`         — mark the run paused so an operator can intervene.
 *                        Default — safe for stages where rerunning is cheap
 *                        but human review is the right next step.
 *   - `abort`         — fail the run outright. Use for stages where any
 *                        failure is structural (e.g. config invalid).
 *   - `cold_restart`  — destroy the sandbox, recreate from
 *                        `sandbox_config.base_image` (instead of warm_image),
 *                        restore prior-stage artifacts, and retry from this
 *                        stage. Used as the explicit opt-in trigger for the
 *                        Tier 2 cold-restart fallback. The runner ALSO triggers
 *                        cold-restart automatically when it detects a
 *                        dep-install signature in the stage events, regardless
 *                        of `on_failure`. See decision 4 in the plan.
 */
export const OnFailureSchema = z.enum([
  'retry',
  'pause',
  'abort',
  'cold_restart',
]);
export type OnFailure = z.infer<typeof OnFailureSchema>;

/**
 * One step of the pipeline. Stages run sequentially in their declared order.
 */
export const StageSchema = z
  .object({
    name: z.string().min(1).describe('Unique stage name within the pipeline.'),
    agent_config: StageAgentConfigSchema,
    artifacts: z.array(ArtifactSchema).default([]),
    gate: GateSchema.optional(),
    on_failure: OnFailureSchema.default('pause'),
  })
  .strict();

export type Stage = z.infer<typeof StageSchema>;

/**
 * Top-level pipeline definition that drives a Requirement end-to-end.
 *
 * Constraints:
 *  - At least one stage.
 *  - Stage names must be unique within a pipeline (validated via superRefine).
 */
export const PipelineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    stages: z.array(StageSchema).min(1, 'pipeline must declare at least one stage'),
  })
  .strict()
  .superRefine((pipeline, ctx) => {
    const seen = new Set<string>();
    pipeline.stages.forEach((stage, index) => {
      if (seen.has(stage.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', index, 'name'],
          message: `duplicate stage name: "${stage.name}"`,
        });
      } else {
        seen.add(stage.name);
      }
    });
  });

export type Pipeline = z.infer<typeof PipelineSchema>;
