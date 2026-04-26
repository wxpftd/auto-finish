import { Hono } from 'hono';
import { z } from 'zod';
import {
  PipelineSchema,
  parsePipelineYaml,
  type Pipeline,
} from '@auto-finish/pipeline-schema';
import type { Db } from '../../db/index.js';
import { pipelines } from '../../db/index.js';
import { validateJson } from '../_validate.js';

/**
 * Body for `POST /api/pipelines`. Accepts either a structured `definition`
 * matching `PipelineSchema`, or a `yaml` string the server will parse.
 *
 * `version` is required by the DB schema but optional in the body — when
 * omitted, the pipeline definition's own `version` field is used, falling
 * back to `'1'`.
 */
const CreatePipelineBody = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    definition: PipelineSchema.optional(),
    yaml: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const hasDef = body.definition !== undefined;
    const hasYaml = body.yaml !== undefined;
    if (hasDef === hasYaml) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message:
          "exactly one of 'definition' or 'yaml' must be provided",
      });
    }
  });

export interface PipelinesRouteDeps {
  db: Db;
}

export function buildPipelinesRoute(deps: PipelinesRouteDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  app.get('/', (c) => {
    const rows = pipelines.listPipelines(db);
    return c.json({ pipelines: rows });
  });

  app.post('/', async (c) => {
    const result = await validateJson(c, CreatePipelineBody);
    if (!result.ok) return result.response;
    const body = result.data;

    let definition: Pipeline;
    if (body.definition !== undefined) {
      definition = body.definition;
    } else {
      // body.yaml is guaranteed by the superRefine above; assert for the type
      // checker rather than re-check at runtime.
      if (body.yaml === undefined) {
        throw new Error('unreachable: yaml branch with no yaml');
      }
      try {
        definition = parsePipelineYaml(body.yaml);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return c.json(
          {
            error: 'validation_failed',
            issues: [{ path: 'yaml', message: reason }],
          },
          400,
        );
      }
    }

    const version = body.version ?? definition.version ?? '1';
    const created = pipelines.createPipeline(db, {
      name: body.name,
      version,
      definition_json: definition,
    });
    return c.json({ pipeline: created }, 201);
  });

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const row = pipelines.getPipeline(db, id);
    if (!row) {
      return c.json({ error: 'not_found', message: `pipeline not found: ${id}` }, 404);
    }
    return c.json({ pipeline: row });
  });

  return app;
}
