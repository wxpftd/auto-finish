/**
 * Observability barrel — Langfuse client wrapper for the orchestrator.
 *
 * The orchestrator should always call `loadLangfuseConfig()` once at startup,
 * pass the result to `createObservabilityClient()`, and treat the returned
 * client as the single source of observability for the lifetime of the
 * process. Per-run handles flow from `startRunTrace`; per-stage handles flow
 * from `RunTraceHandle.startStage`. Disabled mode returns a fully no-op
 * client so the orchestrator can call observability unconditionally without
 * nullity checks.
 */

export type { LangfuseConfig } from './config.js';
export { loadLangfuseConfig } from './config.js';

export type {
  ObservabilityClient,
  RunTraceHandle,
  StageSpanHandle,
} from './langfuse-client.js';
export { createObservabilityClient } from './langfuse-client.js';
