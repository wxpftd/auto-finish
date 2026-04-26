import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { gate_decisions, stage_executions, schema } from '../../db/index.js';
import { validateJson } from '../_validate.js';
import type { EventBus } from '../../eventbus/index.js';

const DecideBody = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    feedback: z.string().optional(),
    decided_by: z.string().min(1),
  })
  .strict();

export interface BuildGatesRouteDeps {
  db: Db;
  /**
   * Optional in-process event bus. When provided, a successful gate decision
   * publishes a `gate_decided` PipelineEvent on `run:${run_id}`, so the
   * runner can resume immediately instead of waiting for its next poll.
   * Backward-compatible: existing callers that pass only `{ db }` still work.
   */
  bus?: EventBus;
}

/** Back-compat alias for callers that imported the old name. */
export type GatesRouteDeps = BuildGatesRouteDeps;

export function buildGatesRoute(deps: BuildGatesRouteDeps): Hono {
  const app = new Hono();
  const { db, bus } = deps;

  app.get('/pending', (c) => {
    const rows = db
      .select()
      .from(schema.stage_executions)
      .where(eq(schema.stage_executions.status, 'awaiting_gate'))
      .all();
    return c.json({ stage_executions: rows });
  });

  app.post('/:stage_execution_id/decide', async (c) => {
    const stage_execution_id = c.req.param('stage_execution_id');
    const stage = stage_executions.getStageExecution(db, stage_execution_id);
    if (!stage) {
      return c.json(
        {
          error: 'not_found',
          message: `stage_execution not found: ${stage_execution_id}`,
        },
        404,
      );
    }

    const result = await validateJson(c, DecideBody);
    if (!result.ok) return result.response;
    const body = result.data;

    // Check duplicate decision (the gate_decisions table has a UNIQUE on
    // stage_execution_id; surface as 409 instead of letting the DB throw).
    const existing = gate_decisions.getDecision(db, stage_execution_id);
    if (existing) {
      return c.json(
        {
          error: 'conflict',
          message: 'decision already recorded for this stage_execution',
          decision: existing,
        },
        409,
      );
    }

    // Record decision and roll the stage forward in a single transaction so
    // observers never see a half-updated state.
    const persisted = db.transaction((tx) => {
      const decision = gate_decisions.recordDecision(tx, {
        stage_execution_id,
        decision: body.decision,
        feedback: body.feedback ?? null,
        decided_by: body.decided_by,
      });

      const next_status =
        body.decision === 'approved' ? 'gate_approved' : 'gate_rejected';
      const updated = stage_executions.finishStageExecution(tx, stage_execution_id, {
        status: next_status,
      });
      return { decision, stage: updated };
    });

    // Notify any in-process listeners (e.g. the runner waiting at this gate).
    // `stage_executions.run_id` IS the pipeline_run id — no extra join needed.
    // We publish AFTER the transaction commits; if `bus` isn't provided the
    // runner falls back to its DB poll loop, so omitting this is safe.
    if (bus !== undefined) {
      bus.publish({
        topic: `run:${stage.run_id}`,
        event: {
          kind: 'gate_decided',
          run_id: stage.run_id,
          stage_name: stage.stage_name,
          decision: body.decision,
          feedback: body.feedback,
        },
        emitted_at: new Date().toISOString(),
      });
    }

    return c.json(persisted, 201);
  });

  return app;
}
