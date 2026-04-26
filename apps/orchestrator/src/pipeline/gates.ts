/**
 * Gate decision helpers.
 *
 * Encapsulates the (currently simple) rules around when a stage requires a
 * human gate and what a decision means. Future configurable rules — quorum,
 * delegated approvers, conditional gates — can grow here without rippling
 * across the orchestrator.
 *
 * Pure functions, no I/O.
 */

import type { Stage } from '@auto-finish/pipeline-schema';
import type { GateRequiredEvent } from './events.js';
import type { PlannedStage } from './plan.js';

/**
 * True iff the given stage requires a human gate before progression.
 *
 * Accepts either a raw `Stage` (from the schema) or a `PlannedStage` (from
 * the execution plan). For a `PlannedStage`, we trust `has_gate` directly;
 * for a `Stage`, we check `gate.required`.
 */
export function stageNeedsGate(stage: Stage | PlannedStage): boolean {
  if ('has_gate' in stage) {
    return stage.has_gate;
  }
  return stage.gate !== undefined && stage.gate.required === true;
}

/**
 * Whether a particular gate decision blocks the run from advancing.
 *
 * `rejected` blocks (the run goes back to `awaiting_changes`); `approved`
 * does not. Centralized so a future "rejected with allow-override" rule has
 * one place to grow.
 */
export function gateBlocksProgression(
  decision: 'approved' | 'rejected',
): boolean {
  return decision === 'rejected';
}

/**
 * Construct the canonical `gate_required` event for a planned stage.
 *
 * Pulls `review_targets` from the stage's gate spec. Throws if the stage
 * doesn't actually have a gate — callers should use `stageNeedsGate` first.
 *
 * `at` is required so callers control the clock (this module remains pure).
 */
export function buildGateRequiredEvent(args: {
  run_id: string;
  stage: PlannedStage;
  at: string;
}): GateRequiredEvent {
  const { run_id, stage, at } = args;
  if (!stage.has_gate || stage.gate === undefined) {
    throw new Error(
      `buildGateRequiredEvent: stage "${stage.name}" has no gate`,
    );
  }
  return {
    kind: 'gate_required',
    run_id,
    stage_name: stage.name,
    review_targets: [...stage.gate.review_targets],
    at,
  };
}
