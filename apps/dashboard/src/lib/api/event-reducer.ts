/**
 * Pure reducer for `PipelineEvent` -> view state on the requirement detail
 * page. Extracted from `src/routes/requirements/[id]/+page.svelte` so it can
 * be unit-tested without component machinery.
 *
 * The reducer is deliberately keyed on the same event kinds the orchestrator
 * publishes — keep this `switch` exhaustive (the `default:` arm asserts
 * `never`, so adding a new `PipelineEvent` variant in `types.ts` without a
 * case here will fail the type-check).
 */

import type {
  PipelineEvent,
  RequirementStatus,
  StageExecution,
} from './types.js';

export interface LogEntry {
  /** Wall-clock millis when the entry was appended. */
  at: number;
  line: string;
}

export interface EventViewState {
  log: LogEntry[];
  liveStatus: RequirementStatus | string;
  currentStage: string | null;
  stages: StageExecution[];
}

/** Cap on log entries kept in memory; the page only renders the tail anyway. */
const LOG_TAIL = 99;

function appendLog(log: LogEntry[], line: string, at: number): LogEntry[] {
  return [...log.slice(-LOG_TAIL), { at, line }];
}

function patchStage(
  stages: StageExecution[],
  stage_name: string,
  patch: Partial<StageExecution>,
): StageExecution[] {
  return stages.map((s) =>
    s.stage_name === stage_name ? { ...s, ...patch } : s,
  );
}

/**
 * Apply a single `PipelineEvent` to the view state. Pure — never mutates the
 * input. The optional `now` parameter exists so tests can pin timestamps.
 */
export function reduceEvent(
  state: EventViewState,
  ev: PipelineEvent,
  now: number = Date.now(),
): EventViewState {
  switch (ev.kind) {
    case 'run_started':
      return {
        ...state,
        log: appendLog(state.log, `run started`, now),
        liveStatus: 'running',
      };
    case 'stage_started':
      return {
        ...state,
        log: appendLog(state.log, `stage started: ${ev.stage_name}`, now),
        currentStage: ev.stage_name,
        liveStatus: 'running',
        stages: patchStage(state.stages, ev.stage_name, {
          status: 'running',
          started_at: Date.parse(ev.at),
        }),
      };
    case 'stage_completed':
      return {
        ...state,
        log: appendLog(
          state.log,
          `stage completed: ${ev.stage_name} (${ev.duration_ms}ms)`,
          now,
        ),
        stages: patchStage(state.stages, ev.stage_name, {
          status: 'succeeded',
          finished_at: Date.parse(ev.at),
        }),
      };
    case 'stage_failed':
      return {
        ...state,
        log: appendLog(
          state.log,
          `stage failed: ${ev.stage_name} — ${ev.error}`,
          now,
        ),
        stages: patchStage(state.stages, ev.stage_name, {
          status: 'failed',
          finished_at: Date.parse(ev.at),
        }),
        liveStatus: 'failed',
      };
    case 'stage_artifact_produced':
      return {
        ...state,
        log: appendLog(state.log, `artifact: ${ev.artifact_path}`, now),
      };
    case 'gate_required':
      return {
        ...state,
        log: appendLog(state.log, `gate required: ${ev.stage_name}`, now),
        currentStage: ev.stage_name,
        liveStatus: 'awaiting_gate',
        stages: patchStage(state.stages, ev.stage_name, {
          status: 'awaiting_gate',
        }),
      };
    case 'gate_decided':
      return {
        ...state,
        log: appendLog(
          state.log,
          `gate decided: ${ev.stage_name} → ${ev.decision}`,
          now,
        ),
        stages: patchStage(state.stages, ev.stage_name, {
          status:
            ev.decision === 'approved' ? 'gate_approved' : 'gate_rejected',
        }),
        liveStatus:
          ev.decision === 'rejected' ? 'awaiting_changes' : state.liveStatus,
      };
    case 'run_completed':
      return {
        ...state,
        log: appendLog(state.log, `run completed`, now),
        liveStatus: 'done',
      };
    case 'run_failed':
      return {
        ...state,
        log: appendLog(state.log, `run failed: ${ev.error}`, now),
        liveStatus: 'failed',
      };
    case 'run_paused':
      return {
        ...state,
        log: appendLog(state.log, `run paused: ${ev.reason}`, now),
      };
    case 'cold_restart':
      // Tier-2 fallback: orchestrator destroyed the warm sandbox and is
      // retrying the same stage. Display-only — run status is unchanged
      // (the orchestrator's reducer treats this as a no-op).
      return {
        ...state,
        log: appendLog(
          state.log,
          `cold-restart at "${ev.stage_name}" — ${ev.reason}`,
          now,
        ),
      };
    case 'stage_event_appended':
      // Streamed only on `run:{id}:debug` (developer view); the default
      // requirement page never sees these. We're a no-op here so the main
      // page reducer stays compact — the developer dock listens on its own
      // ws connection and renders directly.
      return state;
    default: {
      const exhaustive: never = ev;
      throw new Error(
        `unhandled PipelineEvent: ${String((exhaustive as { kind?: unknown })?.kind)}`,
      );
    }
  }
}
