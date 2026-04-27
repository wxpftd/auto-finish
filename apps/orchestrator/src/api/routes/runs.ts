import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../eventbus/index.js';
import { pipeline_runs, pull_requests, requirements, schema } from '../../db/index.js';
import { runRequirement } from '../../runner/runner.js';
import { defaultMakeSandboxProvider } from '../../sandbox/factory.js';
import { validateJson } from '../_validate.js';

export interface RunsRouteDeps {
  db: Db;
  bus?: EventBus;
}

const StartRunBody = z
  .object({
    requirement_id: z.string().min(1),
  })
  .strict();

export function buildRunsRoute(deps: RunsRouteDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  // Trigger a run for an existing requirement. Fire-and-forget: returns 202
  // with the requirement_id and runs runRequirement in the background. Client
  // polls /api/requirements/:id/runs (or subscribes via WS) for progress.
  //
  // Errors during the async run are logged to stderr but never surfaced to
  // the caller — the run state lives in the DB (stage_executions, requirement
  // status), so a failed run leaves visible breadcrumbs there.
  app.post('/start', async (c) => {
    const result = await validateJson(c, StartRunBody);
    if (!result.ok) return result.response;
    const { requirement_id } = result.data;

    if (!requirements.getRequirement(db, requirement_id)) {
      return c.json(
        { error: 'not_found', message: `requirement not found: ${requirement_id}` },
        404,
      );
    }
    if (!deps.bus) {
      return c.json(
        {
          error: 'no_bus',
          message:
            'orchestrator started without an event bus; runner cannot be triggered',
        },
        503,
      );
    }
    const bus = deps.bus;

    void runRequirement(
      { db, bus, makeSandboxProvider: defaultMakeSandboxProvider },
      requirement_id,
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[runs] runRequirement failed for ${requirement_id}: ${msg}`);
    });

    return c.json({ accepted: true, requirement_id }, 202);
  });

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
