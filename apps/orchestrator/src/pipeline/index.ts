/**
 * Pipeline orchestration — pure logic.
 *
 * Re-exports:
 *  - `events`: typed `PipelineEvent` discriminated union
 *  - `state`: `RunStatus` and the `reduceRunStatus` reducer
 *  - `plan`: `ExecutionPlan`, `buildExecutionPlan`, traversal helpers
 *  - `gates`: gate decision helpers
 *
 * No I/O, no DB, no sandbox. Safe to use server-side or in tests.
 */

export type {
  PipelineEvent,
  PipelineEventKind,
  RunStartedEvent,
  StageStartedEvent,
  StageArtifactProducedEvent,
  StageCompletedEvent,
  StageFailedEvent,
  GateRequiredEvent,
  GateDecidedEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunPausedEvent,
} from './events.js';

export type { RunStatus } from './state.js';
export { INITIAL_RUN_STATUS, reduceRunStatus } from './state.js';

export type { ExecutionPlan, PlannedStage } from './plan.js';
export { buildExecutionPlan, findNextStage, findStage } from './plan.js';

export {
  stageNeedsGate,
  gateBlocksProgression,
  buildGateRequiredEvent,
} from './gates.js';
