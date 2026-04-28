import { Hono } from 'hono';
import type { Db } from '../../db/index.js';
import {
  artifacts as artifactsRepo,
  pipeline_runs,
  stage_executions,
} from '../../db/index.js';

export interface ArtifactsRouteDeps {
  db: Db;
}

export function buildArtifactsRoute(deps: ArtifactsRouteDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  app.get('/run/:run_id', (c) => {
    const id = c.req.param('run_id');
    if (!pipeline_runs.getRun(db, id)) {
      return c.json(
        { error: 'not_found', message: `run not found: ${id}` },
        404,
      );
    }
    const rows = artifactsRepo.listArtifactsForRun(db, id);
    return c.json({ artifacts: rows });
  });

  app.get('/stage/:stage_execution_id', (c) => {
    const id = c.req.param('stage_execution_id');
    if (!stage_executions.getStageExecution(db, id)) {
      return c.json(
        { error: 'not_found', message: `stage_execution not found: ${id}` },
        404,
      );
    }
    const rows = artifactsRepo.listArtifactsForStage(db, id);
    return c.json({ artifacts: rows });
  });

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const a = artifactsRepo.getArtifact(db, id);
    if (!a) {
      return c.json(
        { error: 'not_found', message: `artifact not found: ${id}` },
        404,
      );
    }
    return c.json({ artifact: a });
  });

  return app;
}
