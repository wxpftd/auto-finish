/**
 * Compose the orchestrator HTTP API.
 *
 * `buildApp({ db })` returns a Hono app with every route module mounted under
 * `/api/<segment>`, plus a `/healthz` probe and a JSON error handler that
 * never leaks stack traces.
 *
 * The function takes its dependencies via parameter so unit tests can pass an
 * in-memory DB built with `createInMemoryDb()`. `server.ts` is the only place
 * a real DB and the `@hono/node-server` glue live.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Db } from '../db/index.js';
import type { EventBus } from '../eventbus/index.js';
import { buildProjectsRoute } from './routes/projects.js';
import { buildPipelinesRoute } from './routes/pipelines.js';
import { buildRequirementsRoute } from './routes/requirements.js';
import { buildRunsRoute } from './routes/runs.js';
import { buildGatesRoute } from './routes/gates.js';
import { buildArtifactsRoute } from './routes/artifacts.js';

export interface AppDeps {
  db: Db;
  /**
   * Allowed CORS origins. `'*'` in dev when undefined; in prod, configure
   * via `ORCHESTRATOR_CORS_ORIGINS` (comma-separated) and pass through.
   */
  corsOrigins?: string[];
  /**
   * Optional in-process event bus. When provided, the gates route will
   * publish `gate_decided` events so a runner waiting at the gate can
   * resume immediately. Backward-compatible: existing callers that pass
   * only `{ db }` still work.
   */
  bus?: EventBus;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      // Hono treats array form as literal-match; string '*' is the wildcard.
      origin: deps.corsOrigins ?? '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['content-type', 'authorization'],
      maxAge: 600,
      credentials: false,
    }),
  );

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.route('/api/projects', buildProjectsRoute(deps));
  app.route('/api/pipelines', buildPipelinesRoute(deps));
  app.route('/api/requirements', buildRequirementsRoute(deps));
  app.route('/api/runs', buildRunsRoute(deps));
  app.route('/api/gates', buildGatesRoute({ db: deps.db, bus: deps.bus }));
  app.route('/api/artifacts', buildArtifactsRoute({ db: deps.db }));

  app.notFound((c) =>
    c.json({ error: 'not_found', message: `route not found: ${c.req.path}` }, 404),
  );

  // Top-level error handler: hide stacks but preserve the error message and a
  // stable shape so the dashboard can render it. The orchestrator should
  // surface its own structured errors via 4xx responses; anything reaching
  // here is genuinely unexpected.
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : 'internal_error';
    return c.json({ error: 'internal_error', message }, 500);
  });

  return app;
}
