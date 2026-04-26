import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { pipeline_runs, pull_requests, schema } from '../../db/index.js';

export interface RunsRouteDeps {
  db: Db;
}

export function buildRunsRoute(deps: RunsRouteDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const run = pipeline_runs.getRun(db, id);
    if (!run) {
      return c.json(
        { error: 'not_found', message: `run not found: ${id}` },
        404,
      );
    }
    const stages = db
      .select()
      .from(schema.stage_executions)
      .where(eq(schema.stage_executions.run_id, id))
      .all();
    return c.json({
      run: {
        ...run,
        per_repo_branches: run.per_repo_branches_json,
        stage_executions: stages,
      },
    });
  });

  app.get('/:id/stages', (c) => {
    const id = c.req.param('id');
    if (!pipeline_runs.getRun(db, id)) {
      return c.json(
        { error: 'not_found', message: `run not found: ${id}` },
        404,
      );
    }
    const stages = db
      .select()
      .from(schema.stage_executions)
      .where(eq(schema.stage_executions.run_id, id))
      .all();
    return c.json({ stage_executions: stages });
  });

  app.get('/:id/events', (c) => {
    // MVP: aggregate the `events_json` arrays of every stage execution under
    // this run, in `started_at` order, into a single flat list. The "SSE"
    // upgrade is left to the orchestrator-core agent — the contract here is
    // the JSON envelope shape.
    const id = c.req.param('id');
    if (!pipeline_runs.getRun(db, id)) {
      return c.json(
        { error: 'not_found', message: `run not found: ${id}` },
        404,
      );
    }
    const stages = db
      .select()
      .from(schema.stage_executions)
      .where(eq(schema.stage_executions.run_id, id))
      .all();
    const ordered = [...stages].sort((a, b) => a.started_at - b.started_at);
    const events = ordered.flatMap((s) =>
      s.events_json.map((ev) => ({
        stage_execution_id: s.id,
        stage_name: s.stage_name,
        ...ev,
      })),
    );
    return c.json({ events });
  });

  app.get('/:id/prs', (c) => {
    const id = c.req.param('id');
    if (!pipeline_runs.getRun(db, id)) {
      return c.json(
        { error: 'not_found', message: `run not found: ${id}` },
        404,
      );
    }
    const rows = pull_requests.listPRsForRun(db, id);
    return c.json({ pull_requests: rows });
  });

  return app;
}
