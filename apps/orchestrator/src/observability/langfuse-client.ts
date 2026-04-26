/**
 * Langfuse observability client wrapper.
 *
 * Two integration paths the orchestrator can use, both gated by
 * {@link LangfuseConfig}:
 *
 * **Path A — Proxy mode** (Path A; cosmetic code change):
 * The orchestrator injects `ANTHROPIC_BASE_URL` into the `claude` subprocess
 * environment so all Anthropic API calls flow through a Langfuse-compatible
 * proxy. NB: as of `langfuse@3.38.x`, Langfuse server itself does **not**
 * expose a built-in Anthropic-compatible proxy endpoint. The recommended
 * pattern is to point `LANGFUSE_BASE_URL` at a LiteLLM proxy (configured to
 * forward Anthropic requests and report to Langfuse), or to use the official
 * Claude Code Stop hook. `proxyEnvVars()` therefore returns the configured
 * `baseUrl` verbatim — operators are responsible for ensuring it speaks the
 * Anthropic wire format. See:
 * https://github.com/langfuse/langfuse-docs/blob/main/content/integrations/other/claude-code.mdx
 *
 * **Path B — Manual instrumentation** (the work this module does):
 * Each PipelineRun becomes a Langfuse trace; each StageExecution becomes a
 * span on that trace. `ClaudeStageEvent`s update span input/output and attach
 * tool-use annotations. PipelineEvents that don't fit the trace/span model
 * (e.g. gate events) are recorded as trace-level Langfuse events.
 *
 * **Failure isolation contract**: Every SDK call site is guarded; failures are
 * logged via `console.warn` and swallowed. Observability must never break a
 * pipeline run.
 */

import { Langfuse } from 'langfuse';
import type {
  LangfuseTraceClient,
  LangfuseSpanClient,
} from 'langfuse';
import type { PipelineEvent } from '../pipeline/index.js';
import type { ClaudeStageEvent } from '../claude/stage-event.js';
import type { LangfuseConfig } from './config.js';

/** Top-level observability handle the orchestrator holds for its lifetime. */
export interface ObservabilityClient {
  /** Begin a Langfuse trace for one PipelineRun. */
  startRunTrace(args: {
    run_id: string;
    requirement_id: string;
    project_id: string;
    pipeline_id: string;
  }): RunTraceHandle;
  /**
   * Env vars to inject into the `claude` subprocess for Path A
   * (proxy mode). Returns `{}` when proxy mode is disabled.
   */
  proxyEnvVars(): Record<string, string>;
  /** Flush pending traces and stop the SDK background flusher. */
  shutdown(): Promise<void>;
}

/** Per-run handle. Returned by {@link ObservabilityClient.startRunTrace}. */
export interface RunTraceHandle {
  /** Begin a span for one StageExecution. */
  startStage(args: { stage_name: string; index: number }): StageSpanHandle;
  /** Record any orchestrator-level pipeline event on the trace. */
  ingestEvent(event: PipelineEvent): void;
  /** Mark the trace as finished. */
  finish(args: { status: 'completed' | 'failed'; error?: string }): void;
}

/** Per-stage handle. Returned by {@link RunTraceHandle.startStage}. */
export interface StageSpanHandle {
  /** Capture a `ClaudeStageEvent` against this stage's span. */
  ingestClaudeEvent(event: ClaudeStageEvent): void;
  /** End the span. Metrics, when present, become span metadata. */
  finish(args: {
    status: 'success' | 'failure' | 'gate_blocked';
    metrics?: {
      total_cost_usd?: number;
      num_turns?: number;
      duration_ms?: number;
    };
  }): void;
}

/**
 * Construct an `ObservabilityClient`. When `config.enabled` is false a no-op
 * implementation is returned so the orchestrator can call observability
 * unconditionally without nullity checks.
 */
export function createObservabilityClient(
  config: LangfuseConfig,
): ObservabilityClient {
  if (!config.enabled) {
    return NOOP_CLIENT;
  }

  let langfuse: Langfuse | undefined;
  try {
    langfuse = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
    });
  } catch (err) {
    console.warn(
      '[observability] Langfuse SDK init failed; degrading to no-op:',
      err,
    );
    return NOOP_CLIENT;
  }

  const sampleRate = config.sampleRate ?? 1;

  return {
    startRunTrace(args) {
      let trace: LangfuseTraceClient | undefined;
      try {
        trace = langfuse?.trace({
          id: args.run_id,
          name: `pipeline-run:${args.pipeline_id}`,
          metadata: {
            run_id: args.run_id,
            requirement_id: args.requirement_id,
            project_id: args.project_id,
            pipeline_id: args.pipeline_id,
          },
          tags: ['pipeline-run', `project:${args.project_id}`],
        });
      } catch (err) {
        console.warn('[observability] startRunTrace failed:', err);
      }
      return makeRunTraceHandle(trace, sampleRate);
    },

    proxyEnvVars(): Record<string, string> {
      const empty: Record<string, string> = {};
      if (config.enableProxy !== true) {
        return empty;
      }
      const baseUrl = config.baseUrl;
      if (baseUrl === undefined || baseUrl === '') {
        return empty;
      }
      return { ANTHROPIC_BASE_URL: baseUrl };
    },

    async shutdown() {
      if (langfuse === undefined) {
        return;
      }
      try {
        await langfuse.shutdownAsync();
      } catch (err) {
        console.warn('[observability] shutdownAsync failed:', err);
      }
    },
  };
}

function makeRunTraceHandle(
  trace: LangfuseTraceClient | undefined,
  sampleRate: number,
): RunTraceHandle {
  return {
    startStage(args) {
      // Sampling: traces are always created (so run timing is preserved);
      // per-stage spans are sampled.
      if (trace === undefined || Math.random() >= sampleRate) {
        return NOOP_STAGE_HANDLE;
      }
      let span: LangfuseSpanClient | undefined;
      try {
        span = trace.span({
          name: `stage:${args.stage_name}`,
          metadata: {
            stage_name: args.stage_name,
            stage_index: args.index,
          },
        });
      } catch (err) {
        console.warn('[observability] startStage failed:', err);
        return NOOP_STAGE_HANDLE;
      }
      return makeStageSpanHandle(span);
    },

    ingestEvent(event) {
      if (trace === undefined) {
        return;
      }
      try {
        trace.event({
          name: `pipeline:${event.kind}`,
          metadata: event as unknown as Record<string, unknown>,
        });
      } catch (err) {
        console.warn('[observability] ingestEvent failed:', err);
      }
    },

    finish(args) {
      if (trace === undefined) {
        return;
      }
      try {
        const update: { output: unknown; metadata: unknown } = {
          output: { status: args.status, error: args.error },
          metadata: { final_status: args.status },
        };
        trace.update(update);
      } catch (err) {
        console.warn('[observability] trace finish failed:', err);
      }
    },
  };
}

function makeStageSpanHandle(
  span: LangfuseSpanClient | undefined,
): StageSpanHandle {
  if (span === undefined) {
    return NOOP_STAGE_HANDLE;
  }
  return {
    ingestClaudeEvent(event) {
      try {
        switch (event.kind) {
          case 'session_init':
            span.update({
              input: {
                session_id: event.session_id,
                model: event.model,
                tools: event.tools,
              },
            });
            break;
          case 'tool_use':
            span.event({
              name: `tool_use:${event.tool}`,
              metadata: {
                tool: event.tool,
                tool_use_id: event.id,
                input: event.input,
              },
            });
            break;
          case 'rate_limited':
            span.event({
              name: 'rate_limited',
              metadata: { reset_at: event.reset_at },
            });
            break;
          case 'parse_error':
            span.event({
              name: 'parse_error',
              metadata: { error: event.error, raw: event.raw },
            });
            break;
          case 'finished':
            span.update({
              metadata: {
                exit_code: event.exit_code,
                total_cost_usd: event.total_cost_usd,
                num_turns: event.num_turns,
                duration_ms: event.duration_ms,
                usage: event.usage,
              },
            });
            break;
          case 'failed':
            span.update({
              metadata: { failure_reason: event.reason },
            });
            break;
          // assistant_text and tool_result are intentionally not shipped per
          // event — they would create a flood of events. Final assistant
          // output is captured via `finished` metadata or the proxy path.
          case 'assistant_text':
          case 'tool_result':
            break;
        }
      } catch (err) {
        console.warn('[observability] ingestClaudeEvent failed:', err);
      }
    },

    finish(args) {
      try {
        const level: 'DEFAULT' | 'ERROR' | 'WARNING' =
          args.status === 'success'
            ? 'DEFAULT'
            : args.status === 'gate_blocked'
              ? 'WARNING'
              : 'ERROR';
        span.end({
          output: { status: args.status },
          metadata: { status: args.status, ...(args.metrics ?? {}) },
          level,
        });
      } catch (err) {
        console.warn('[observability] stage finish failed:', err);
      }
    },
  };
}

// -----------------------------------------------------------------------------
// No-op implementations — used when observability is disabled or when the
// SDK fails to initialise. Every method is a safe no-op so the orchestrator
// can call observability unconditionally.
// -----------------------------------------------------------------------------

const NOOP_STAGE_HANDLE: StageSpanHandle = {
  ingestClaudeEvent() {
    /* no-op */
  },
  finish() {
    /* no-op */
  },
};

const NOOP_RUN_HANDLE: RunTraceHandle = {
  startStage() {
    return NOOP_STAGE_HANDLE;
  },
  ingestEvent() {
    /* no-op */
  },
  finish() {
    /* no-op */
  },
};

const NOOP_CLIENT: ObservabilityClient = {
  startRunTrace() {
    return NOOP_RUN_HANDLE;
  },
  proxyEnvVars() {
    return {};
  },
  async shutdown() {
    /* no-op */
  },
};
