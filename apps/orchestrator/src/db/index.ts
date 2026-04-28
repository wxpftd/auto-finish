/**
 * Public surface of the orchestrator persistence layer.
 *
 * Repository modules are re-exported under their entity name so callers can
 * write `projects.createProject(db, ...)`, `requirements.listRequirements(db, ...)`
 * etc. — the `db` handle is always the first argument.
 */

export * as schema from './schema.js';
export {
  createDb,
  createInMemoryDb,
  runMigrations,
} from './client.js';
export type { Db, DbHandle, Schema, SqliteHandle } from './client.js';

export * as projects from './repositories/projects.js';
export * as repos from './repositories/repos.js';
export * as pipelines from './repositories/pipelines.js';
export * as requirements from './repositories/requirements.js';
export * as pipeline_runs from './repositories/pipeline_runs.js';
export * as stage_executions from './repositories/stage_executions.js';
export * as gate_decisions from './repositories/gate_decisions.js';
export * as pull_requests from './repositories/pull_requests.js';
export * as artifacts from './repositories/artifacts.js';
