/**
 * Higher-level events emitted by the pipeline orchestrator.
 *
 * These are pure data — no methods, no behavior. The orchestrator persists
 * them, broadcasts them over WebSocket to the dashboard, and feeds them
 * through `reduceRunStatus` to derive the run's current state.
 *
 * `at` is an ISO-8601 timestamp string. Callers (the orchestrator runtime,
 * tests during replay) supply it; nothing in this module reads the clock.
 */

/** Run started — first event of any run. */
export interface RunStartedEvent {
  kind: 'run_started';
  run_id: string;
  requirement_id: string;
  at: string;
}

/** A new stage has begun executing. */
export interface StageStartedEvent {
  kind: 'stage_started';
  run_id: string;
  stage_name: string;
  at: string;
}

/** A stage produced an artifact. Informational; does not change run status. */
export interface StageArtifactProducedEvent {
  kind: 'stage_artifact_produced';
  run_id: string;
  stage_name: string;
  artifact_path: string;
}

/** A stage finished successfully. */
export interface StageCompletedEvent {
  kind: 'stage_completed';
  run_id: string;
  stage_name: string;
  at: string;
  duration_ms: number;
}

/** A stage failed. The run typically transitions to `paused` (recoverable). */
export interface StageFailedEvent {
  kind: 'stage_failed';
  run_id: string;
  stage_name: string;
  at: string;
  error: string;
}

/** A human gate is required after the named stage. */
export interface GateRequiredEvent {
  kind: 'gate_required';
  run_id: string;
  stage_name: string;
  review_targets: string[];
  at: string;
}

/** A human resolved the gate. */
export interface GateDecidedEvent {
  kind: 'gate_decided';
  run_id: string;
  stage_name: string;
  decision: 'approved' | 'rejected';
  feedback?: string;
}

/** Whole run completed successfully. Terminal. */
export interface RunCompletedEvent {
  kind: 'run_completed';
  run_id: string;
  at: string;
}

/** Whole run failed unrecoverably. Terminal. */
export interface RunFailedEvent {
  kind: 'run_failed';
  run_id: string;
  at: string;
  error: string;
}

/** Run was paused (recoverable — operator may resume). */
export interface RunPausedEvent {
  kind: 'run_paused';
  run_id: string;
  at: string;
  reason: string;
}

/** Discriminated union of every pipeline event. */
export type PipelineEvent =
  | RunStartedEvent
  | StageStartedEvent
  | StageArtifactProducedEvent
  | StageCompletedEvent
  | StageFailedEvent
  | GateRequiredEvent
  | GateDecidedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunPausedEvent;

/** Convenience: every kind string in the union. */
export type PipelineEventKind = PipelineEvent['kind'];
