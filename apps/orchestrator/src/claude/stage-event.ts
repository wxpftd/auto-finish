/**
 * `ClaudeStageEvent` — typed events emitted by the spawn coordinator
 * (`runClaudeStage`) to its consumer (the pipeline runner).
 *
 * These are higher-level than the raw `ClaudeStreamEvent` from `./schema.js`:
 * the spawn coordinator translates raw stream-json into this discriminated
 * union so downstream code does not have to know about the CLI wire format.
 *
 * Design notes:
 * - Every event carries enough information to be persisted as a row in a
 *   `StageExecution.events` log; consumers must not need the raw event to
 *   render dashboards or write artifacts.
 * - `parse_error` is forwarded (not swallowed) so operators can see schema
 *   drift in real captures.
 * - `failed` is emitted only for unrecoverable session-level errors (e.g.
 *   session destroyed, transport hung up); CLI exit codes flow through
 *   `finished` regardless of value.
 */

export type ClaudeStageEvent =
  | {
      kind: 'session_init';
      session_id: string;
      model: string;
      tools: string[];
    }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; tool: string; input: unknown; id: string }
  | {
      kind: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }
  | { kind: 'rate_limited'; reset_at?: string }
  | { kind: 'parse_error'; raw: string; error: string }
  | {
      kind: 'finished';
      exit_code: number;
      total_cost_usd?: number;
      num_turns?: number;
      duration_ms?: number;
      usage?: unknown;
    }
  | { kind: 'failed'; reason: string };
