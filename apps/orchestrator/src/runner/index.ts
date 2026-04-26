/**
 * Pipeline Runner — drives a Requirement through its Pipeline end-to-end.
 *
 * Public surface: `runRequirement(deps, requirementId)` and the supporting
 * dependency types. Most external interactions are pluggable so the same
 * code path drives production runs and unit tests.
 */

export { runRequirement } from './runner.js';
export type {
  RunnerDeps,
  RunResult,
  BootstrapEnvFn,
  DetectChangesFn,
  InjectCredentialsFn,
  OpenPrsFn,
  RunClaudeFn,
} from './types.js';
