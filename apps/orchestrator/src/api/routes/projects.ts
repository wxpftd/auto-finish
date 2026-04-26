import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/index.js';
import { projects, repos } from '../../db/index.js';
import { validateJson } from '../_validate.js';
import {
  ProjectConfigSchema,
  RepoConfigSchema,
  parseProjectYaml,
  type ProjectConfig,
} from '@auto-finish/project-schema';
import { parsePipelineYaml } from '@auto-finish/pipeline-schema';

/**
 * Wire-format body for `POST /api/projects`.
 *
 * Derived from `ProjectConfigSchema` minus `id` and `repos`: the DB generates
 * the primary key, and repos are added via `POST /:id/repos`.
 */
const CreateProjectBody = ProjectConfigSchema._def.schema.omit({
  id: true,
  repos: true,
});

const AddRepoBody = RepoConfigSchema;

const FromYamlBody = z
  .object({
    project_yaml: z.string().min(1).optional(),
    yaml: z.string().min(1).optional(),
    pipeline_yaml: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.project_yaml === undefined && body.yaml === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "either 'project_yaml' or 'yaml' must be provided",
      });
    }
  });

export interface ProjectsRouteDeps {
  db: Db;
}

export function buildProjectsRoute(deps: ProjectsRouteDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  app.get('/', (c) => {
    const rows = projects.listProjects(db);
    return c.json({ projects: rows });
  });

  app.post('/', async (c) => {
    const result = await validateJson(c, CreateProjectBody);
    if (!result.ok) return result.response;
    const body = result.data;

    const created = projects.createProject(db, {
      name: body.name,
      description: body.description ?? null,
      default_pipeline_id: body.default_pipeline_id ?? null,
      sandbox_config_json: body.sandbox_config,
      claude_config_json: body.claude_config,
    });
    return c.json({ project: created }, 201);
  });

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const row = projects.getProject(db, id);
    if (!row) {
      return c.json(
        { error: 'not_found', message: `project not found: ${id}` },
        404,
      );
    }
    return c.json({ project: row });
  });

  app.get('/:id/repos', (c) => {
    const id = c.req.param('id');
    if (!projects.getProject(db, id)) {
      return c.json(
        { error: 'not_found', message: `project not found: ${id}` },
        404,
      );
    }
    const rows = repos.listReposForProject(db, id);
    return c.json({ repos: rows });
  });

  app.post('/:id/repos', async (c) => {
    const id = c.req.param('id');
    if (!projects.getProject(db, id)) {
      return c.json(
        { error: 'not_found', message: `project not found: ${id}` },
        404,
      );
    }
    const result = await validateJson(c, AddRepoBody);
    if (!result.ok) return result.response;
    const body = result.data;

    const created = repos.addRepo(db, {
      project_id: id,
      name: body.name,
      git_url: body.git_url,
      default_branch: body.default_branch,
      working_dir: body.working_dir,
      test_command: body.test_command ?? null,
      pr_template: body.pr_template ?? null,
    });
    return c.json({ repo: created }, 201);
  });

  app.post('/from-yaml', async (c) => {
    const result = await validateJson(c, FromYamlBody);
    if (!result.ok) return result.response;
    const body = result.data;

    const projectYaml = body.project_yaml ?? body.yaml;
    if (projectYaml === undefined) {
      throw new Error('unreachable: from-yaml without yaml');
    }

    let project: ProjectConfig;
    try {
      project = parseProjectYaml(projectYaml);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error: 'validation_failed',
          issues: [{ path: 'project_yaml', message: reason }],
        },
        400,
      );
    }

    let pipelineParsed: unknown = undefined;
    if (body.pipeline_yaml !== undefined) {
      try {
        pipelineParsed = parsePipelineYaml(body.pipeline_yaml);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return c.json(
          {
            error: 'validation_failed',
            issues: [{ path: 'pipeline_yaml', message: reason }],
          },
          400,
        );
      }
    }

    const persisted = db.transaction((tx) => {
      const projectRow = projects.createProject(tx, {
        name: project.name,
        description: project.description ?? null,
        default_pipeline_id: project.default_pipeline_id ?? null,
        sandbox_config_json: project.sandbox_config,
        claude_config_json: project.claude_config,
      });
      const repoRows = project.repos.map((r) =>
        repos.addRepo(tx, {
          project_id: projectRow.id,
          name: r.name,
          git_url: r.git_url,
          default_branch: r.default_branch,
          working_dir: r.working_dir,
          test_command: r.test_command ?? null,
          pr_template: r.pr_template ?? null,
        }),
      );
      return { project: projectRow, repos: repoRows };
    });

    return c.json(
      {
        project: persisted.project,
        repos: persisted.repos,
        pipeline_parsed: pipelineParsed,
      },
      201,
    );
  });

  return app;
}
