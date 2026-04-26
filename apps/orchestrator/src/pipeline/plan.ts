/**
 * Execution plan for a pipeline run.
 *
 * A `Pipeline` (validated by @auto-finish/pipeline-schema) is a static
 * declaration. An `ExecutionPlan` is the runtime-friendly view: stages
 * indexed in order, with precomputed metadata the orchestrator needs
 * during scheduling (next stage, gate detection, last-stage detection).
 *
 * Pure data + pure helpers. No I/O, no side effects.
 */

import type { Pipeline, Stage } from '@auto-finish/pipeline-schema';

/** A single stage as seen by the runtime, with ordinal metadata baked in. */
export interface PlannedStage {
  /** Unique within the plan. */
  name: string;
  agent_config: Stage['agent_config'];
  artifacts: Stage['artifacts'];
  /** True iff this stage has a gate that requires human approval. */
  has_gate: boolean;
  /** The gate spec, present iff `has_gate` is true. */
  gate?: Stage['gate'];
  on_failure: Stage['on_failure'];
  /** 0-based ordinal in the pipeline. */
  index: number;
  /** True iff this is the final stage. */
  is_last: boolean;
}

/** The full plan: pipeline metadata + ordered stages + a few summary flags. */
export interface ExecutionPlan {
  pipeline_id: string;
  pipeline_name: string;
  stages: PlannedStage[];
  total_stages: number;
  has_any_gate: boolean;
}

/**
 * Convert a validated `Pipeline` into an `ExecutionPlan`.
 *
 * Schema-level invariants (non-empty stages, unique names) are already
 * enforced by `PipelineSchema`; we re-assert them here so a future caller
 * who builds a `Pipeline`-shaped object outside the schema still gets a
 * loud error.
 */
export function buildExecutionPlan(pipeline: Pipeline): ExecutionPlan {
  if (pipeline.stages.length === 0) {
    throw new Error(
      `buildExecutionPlan: pipeline "${pipeline.id}" has no stages`,
    );
  }

  const seen = new Set<string>();
  for (const stage of pipeline.stages) {
    if (seen.has(stage.name)) {
      throw new Error(
        `buildExecutionPlan: pipeline "${pipeline.id}" has duplicate stage name "${stage.name}"`,
      );
    }
    seen.add(stage.name);
  }

  const total = pipeline.stages.length;
  const stages: PlannedStage[] = pipeline.stages.map((stage, index) => {
    const hasGate = stage.gate !== undefined && stage.gate.required === true;
    const planned: PlannedStage = {
      name: stage.name,
      agent_config: stage.agent_config,
      artifacts: stage.artifacts,
      has_gate: hasGate,
      on_failure: stage.on_failure,
      index,
      is_last: index === total - 1,
    };
    if (stage.gate !== undefined) {
      planned.gate = stage.gate;
    }
    return planned;
  });

  return {
    pipeline_id: pipeline.id,
    pipeline_name: pipeline.name,
    stages,
    total_stages: total,
    has_any_gate: stages.some((s) => s.has_gate),
  };
}

/**
 * Find the next stage to run.
 *
 * - `currentStageName === null` means "give me the first stage".
 * - Returns `null` if `currentStageName` is the last stage (run finished).
 * - Returns `null` if `currentStageName` isn't in the plan (caller is
 *   probably misusing the helper; fail soft so a stale event doesn't
 *   crash the orchestrator).
 */
export function findNextStage(
  plan: ExecutionPlan,
  currentStageName: string | null,
): PlannedStage | null {
  if (currentStageName === null) {
    return plan.stages[0] ?? null;
  }

  const idx = plan.stages.findIndex((s) => s.name === currentStageName);
  if (idx === -1) {
    return null;
  }
  return plan.stages[idx + 1] ?? null;
}

/** Find a stage by name. Returns `null` if not in the plan. */
export function findStage(
  plan: ExecutionPlan,
  stageName: string,
): PlannedStage | null {
  return plan.stages.find((s) => s.name === stageName) ?? null;
}
