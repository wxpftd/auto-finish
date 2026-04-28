/**
 * Pipeline run state machine — pure, total, idempotent-friendly.
 *
 * State graph (kinds shown; payload elided):
 *
 *      ┌───────────┐   run_started        ┌──────────────────┐
 *      │  queued   │ ───── (no-op) ────▶  │      queued      │
 *      └─────┬─────┘                      └──────────────────┘
 *            │ stage_started
 *            ▼
 *      ┌──────────────┐  stage_started   ┌──────────────┐
 *      │   running    │ ───────────────▶ │   running    │ (advance stage)
 *      │  {stage}     │                  │  {next stage}│
 *      └──┬───┬───┬───┴──────────────────────────────────┘
 *         │   │   │
 *         │   │   │ gate_required               ┌────────────────────┐
 *         │   │   └────────────────────────────▶│  awaiting_gate     │
 *         │   │                                 │     {stage}        │
 *         │   │                                 └─────┬────┬─────────┘
 *         │   │                            approved   │    │ rejected
 *         │   │                                       ▼    ▼
 *         │   │                              ┌─────────┐  ┌──────────────────────┐
 *         │   │                              │ running │  │  awaiting_changes    │
 *         │   │                              │ {stage} │  │       {stage}        │
 *         │   │                              └─────────┘  └─────────┬────────────┘
 *         │   │                                                     │ stage_started
 *         │   │                                                     ▼
 *         │   │                                              ┌──────────────┐
 *         │   │                                              │   running    │
 *         │   │ stage_failed / run_paused                    │   {stage}    │
 *         │   ▼                                              └──────────────┘
 *         │  ┌──────────────┐  stage_started  ┌──────────────┐
 *         │  │   paused     │ ──────────────▶ │   running    │
 *         │  │  {reason}    │                 │   {stage}    │
 *         │  └──────────────┘                 └──────────────┘
 *         │
 *         │ run_completed                          run_failed
 *         ▼                                            │
 *      ┌──────────────┐                                ▼
 *      │  completed   │ (terminal)            ┌──────────────┐
 *      └──────────────┘                       │    failed    │ (terminal)
 *                                             │  {error}     │
 *                                             └──────────────┘
 *
 * Conventions:
 *  - This function is pure: same (current, event) → same next.
 *  - It is total: every (current, event) pair returns a value, never throws.
 *  - Events that don't apply to the current state are no-ops (return current
 *    unchanged). This is critical for replay: persisted events may be re-fed
 *    in any order and must not blow up the reducer.
 *  - Terminal states (`completed`, `failed`) absorb all further events.
 *  - `stage_artifact_produced` never changes status — it's informational.
 */

import type { PipelineEvent } from './events.js';

/** All possible run statuses. Discriminated union — `kind` is the tag. */
export type RunStatus =
  | { kind: 'queued' }
  | { kind: 'running'; stage_name: string }
  | { kind: 'awaiting_gate'; stage_name: string }
  | { kind: 'awaiting_changes'; stage_name: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'completed' }
  | { kind: 'failed'; error: string };

/** Convenience constant for the initial status of a freshly created run. */
export const INITIAL_RUN_STATUS: RunStatus = { kind: 'queued' };

/**
 * Apply one event to the current status; return the next status.
 *
 * If the event doesn't apply (e.g. `gate_decided` while `running`), the
 * current status is returned unchanged. Terminal states absorb everything.
 */
export function reduceRunStatus(
  current: RunStatus,
  event: PipelineEvent,
): RunStatus {
  // Terminal states: nothing can change them. Returning early keeps the
  // switch below from ever needing to special-case these states.
  if (current.kind === 'completed' || current.kind === 'failed') {
    return current;
  }

  switch (event.kind) {
    case 'run_started': {
      // `run_started` carries no stage info; we wait for `stage_started` to
      // know which stage we're on. While queued, this event is a no-op.
      // While in any other state, it is also a no-op (likely a replay).
      return current;
    }

    case 'stage_started': {
      // Begin or continue execution. Valid from queued / running /
      // awaiting_changes / paused. Ignored from awaiting_gate (a real
      // run shouldn't get there, but we don't throw on replay).
      switch (current.kind) {
        case 'queued':
        case 'running':
        case 'awaiting_changes':
        case 'paused':
          return { kind: 'running', stage_name: event.stage_name };
        case 'awaiting_gate':
          // Defensive: shouldn't happen — a stage cannot start while a gate
          // is pending. Treat as no-op rather than throw, to keep replay safe.
          return current;
      }
      return current;
    }

    case 'stage_artifact_produced': {
      // Pure information. Status never changes.
      return current;
    }

    case 'stage_completed': {
      // Stage finished. The orchestrator decides what comes next: either a
      // `stage_started` for the next stage, a `gate_required`, or a
      // `run_completed`. We stay in `running` here.
      return current;
    }

    case 'stage_failed': {
      // A stage failed. Default behavior: pause the run so the operator
      // can decide. If the orchestrator wants to abort outright, it should
      // emit `run_failed` instead of relying on this transition.
      if (current.kind === 'running') {
        return { kind: 'paused', reason: event.error };
      }
      return current;
    }

    case 'gate_required': {
      // Move into awaiting_gate from running. From any other state, no-op.
      if (current.kind === 'running') {
        return { kind: 'awaiting_gate', stage_name: event.stage_name };
      }
      return current;
    }

    case 'gate_decided': {
      if (current.kind !== 'awaiting_gate') {
        // A late / replayed gate decision while we've already moved on.
        return current;
      }
      if (event.decision === 'approved') {
        // Resume execution; same stage name until the next stage_started
        // arrives to advance us.
        return { kind: 'running', stage_name: current.stage_name };
      }
      // Rejected: the work needs rework on this stage.
      return { kind: 'awaiting_changes', stage_name: current.stage_name };
    }

    case 'run_paused': {
      // Operator-initiated or systemic pause that isn't tied to a stage error.
      return { kind: 'paused', reason: event.reason };
    }

    case 'run_completed': {
      return { kind: 'completed' };
    }

    case 'run_failed': {
      return { kind: 'failed', error: event.error };
    }

    case 'cold_restart': {
      // Tier 2 cold-restart fallback fired. The runner is about to re-run
      // the same stage in a fresh sandbox. Run status doesn't change —
      // we stay in `running` (or whatever the prior state was; the runner
      // does not transition the run before emitting this event).
      return current;
    }

    case 'stage_event_appended': {
      // Pure observability mirror of a single Claude stream event. The run
      // status is derived from coarse-grained PipelineEvents only — these
      // never change it. (Published on `run:{id}:debug` topic, default
      // dashboard subscribers don't see them.)
      return current;
    }
  }
}
