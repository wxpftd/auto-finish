import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/index.js';
import { requirements, pipeline_runs } from '../../db/index.js';
import { schema } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { validateJson, validateQuery } from '../_validate.js';

const CreateRequirementBody = z
  .object({
    project_id: z.string().min(1),
    pipeline_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    source: z.string().min(1).optional(),
    source_ref: z.string().min(1).optional(),
  })
  .strict();

const ListRequirementsQuery = z
  .object({
    project_id: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
  })
  .strict();

export interface RequirementsRouteDeps {
  db: Db;
}

export function buildRequirementsRoute(deps: RequirementsRouteDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  app.get('/', (c) => {
    const result = validateQuery(c, ListRequirementsQuery);
    if (!result.ok) return result.response;
    const filter = result.data;
    const rows = requirements.listRequirements(db, filter);
    return c.json({ requirements: rows });
  });

  app.post('/', async (c) => {
    const result = await validateJson(c, CreateRequirementBody);
    if (!result.ok) return result.response;
    const body = result.data;

    const created = requirements.createRequirement(db, {
      project_id: body.project_id,
      pipeline_id: body.pipeline_id,
      title: body.title,
      description: body.description,
      source: body.source ?? 'manual',
      source_ref: body.source_ref ?? null,
      status: 'queued',
      current_stage_id: null,
    });
    return c.json({ requirement: created }, 201);
  });

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const row = requirements.getRequirement(db, id);
    if (!row) {
      return c.json(
        { error: 'not_found', message: `requirement not found: ${id}` },
        404,
      );
    }
    return c.json({ requirement: row });
  });

  app.get('/:id/runs', (c) => {
    const id = c.req.param('id');
    if (!requirements.getRequirement(db, id)) {
      return c.json(
        { error: 'not_found', message: `requirement not found: ${id}` },
        404,
      );
    }
    // The repository module exposes `getRunByRequirement` (latest only); we
    // need the full list, so query the schema directly. Reading allowed from
    // the API layer; only repository file authoring is restricted.
    const rows = db
      .select()
      .from(schema.pipeline_runs)
      .where(eq(schema.pipeline_runs.requirement_id, id))
      .all();
    // Keep `pipeline_runs` import live so we can reuse for type inference if
    // future endpoints need it.
    void pipeline_runs;
    return c.json({ runs: rows });
  });

  return app;
}
