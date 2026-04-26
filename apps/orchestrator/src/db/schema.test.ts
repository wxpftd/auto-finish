import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryDb, runMigrations } from './client.js';
import type { Db, SqliteHandle } from './client.js';
import {
  projects,
  repos,
  pipelines,
  requirements,
  pipeline_runs,
  stage_executions,
  artifacts,
  gate_decisions,
  pull_requests,
} from './schema.js';
import type { ClaudeConfig, SandboxConfig } from './schema.js';
import { eq } from 'drizzle-orm';

interface Ctx {
  db: Db;
  sqlite: SqliteHandle;
}

const ctx: Ctx = {} as Ctx;

beforeEach(() => {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  ctx.db = handle.db;
  ctx.sqlite = handle.sqlite;
});

describe('schema migrations', () => {
  it('creates all expected tables', () => {
    const tables = ctx.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([
      'artifacts',
      'gate_decisions',
      'pipeline_runs',
      'pipelines',
      'projects',
      'pull_requests',
      'repos',
      'requirements',
      'stage_executions',
    ]);
  });

  it('enforces foreign key pragma is on', () => {
    const result = ctx.sqlite.pragma('foreign_keys', { simple: true });
    expect(result).toBe(1);
  });
});

describe('json column round-trip', () => {
  it('round-trips nested project sandbox/claude configs', () => {
    const sandbox: SandboxConfig = {
      daytona_endpoint: 'http://localhost:3986',
      image: 'node:20',
      env: { NODE_ENV: 'production', FOO: 'bar' },
      setup_commands: ['pnpm install', 'pnpm build'],
    };
    const claude: ClaudeConfig = {
      credentials_source: 'host_mount',
      allowed_tools: ['Read', 'Write', 'Bash(npm test:*)'],
      mcp_servers: { langfuse: { url: 'http://lf' } },
    };

    const inserted = ctx.db
      .insert(projects)
      .values({
        name: 'demo',
        description: 'demo project',
        sandbox_config_json: sandbox,
        claude_config_json: claude,
      })
      .returning()
      .all()[0];
    if (!inserted) throw new Error('insert returned nothing');

    const fetched = ctx.db
      .select()
      .from(projects)
      .where(eq(projects.id, inserted.id))
      .get();
    expect(fetched).toBeDefined();
    expect(fetched?.sandbox_config_json).toEqual(sandbox);
    expect(fetched?.claude_config_json).toEqual(claude);
  });

  it('round-trips events_json arrays on stage_executions', () => {
    const project = ctx.db
      .insert(projects)
      .values({
        name: 'p',
        sandbox_config_json: {},
        claude_config_json: { credentials_source: 'host_mount' },
      })
      .returning()
      .all()[0];
    if (!project) throw new Error('no project');

    const pipeline = ctx.db
      .insert(pipelines)
      .values({
        name: 'pipe',
        version: '1',
        definition_json: {
          id: 'pipe',
          name: 'pipe',
          stages: [
            {
              name: 's1',
              agent_config: { system_prompt: 'hi', allowed_tools: [] },
              artifacts: [],
              on_failure: 'pause',
            },
          ],
        },
      })
      .returning()
      .all()[0];
    if (!pipeline) throw new Error('no pipeline');

    const requirement = ctx.db
      .insert(requirements)
      .values({
        project_id: project.id,
        pipeline_id: pipeline.id,
        title: 't',
        description: 'd',
        source: 'manual',
        status: 'queued',
      })
      .returning()
      .all()[0];
    if (!requirement) throw new Error('no requirement');

    const run = ctx.db
      .insert(pipeline_runs)
      .values({
        requirement_id: requirement.id,
        pipeline_snapshot_json: pipeline.definition_json,
        per_repo_branches_json: { 'repo-1': 'auto-finish/req-x' },
      })
      .returning()
      .all()[0];
    if (!run) throw new Error('no run');

    const events = [
      { type: 'spawn', ts: 1, pid: 123 },
      { type: 'system_init', ts: 2, session_id: 'abc' },
      { type: 'finish', ts: 3, ok: true },
    ];
    const exec = ctx.db
      .insert(stage_executions)
      .values({
        run_id: run.id,
        stage_name: 's1',
        status: 'running',
        events_json: events,
      })
      .returning()
      .all()[0];
    if (!exec) throw new Error('no exec');

    const fetched = ctx.db
      .select()
      .from(stage_executions)
      .where(eq(stage_executions.id, exec.id))
      .get();
    expect(fetched?.events_json).toEqual(events);
    expect(Array.isArray(fetched?.events_json)).toBe(true);
  });
});

describe('foreign key cascades', () => {
  function seedProject() {
    const project = ctx.db
      .insert(projects)
      .values({
        name: 'p',
        sandbox_config_json: {},
        claude_config_json: { credentials_source: 'host_mount' },
      })
      .returning()
      .all()[0];
    if (!project) throw new Error('no project');
    return project;
  }

  function seedPipeline() {
    const pipeline = ctx.db
      .insert(pipelines)
      .values({
        name: 'pipe',
        version: '1',
        definition_json: {
          id: 'pipe',
          name: 'pipe',
          stages: [
            {
              name: 's1',
              agent_config: { system_prompt: 'hi', allowed_tools: [] },
              artifacts: [],
              on_failure: 'pause',
            },
          ],
        },
      })
      .returning()
      .all()[0];
    if (!pipeline) throw new Error('no pipeline');
    return pipeline;
  }

  it('cascades repos when its project is deleted', () => {
    const project = seedProject();
    ctx.db
      .insert(repos)
      .values({
        project_id: project.id,
        name: 'frontend',
        git_url: 'git@x:f.git',
        default_branch: 'main',
        working_dir: '/workspace/frontend',
      })
      .run();

    expect(ctx.db.select().from(repos).all()).toHaveLength(1);
    ctx.db.delete(projects).where(eq(projects.id, project.id)).run();
    expect(ctx.db.select().from(repos).all()).toHaveLength(0);
  });

  it('restricts deleting a pipeline still referenced by a requirement', () => {
    const project = seedProject();
    const pipeline = seedPipeline();
    ctx.db
      .insert(requirements)
      .values({
        project_id: project.id,
        pipeline_id: pipeline.id,
        title: 't',
        description: 'd',
        source: 'manual',
        status: 'queued',
      })
      .run();

    expect(() =>
      ctx.db.delete(pipelines).where(eq(pipelines.id, pipeline.id)).run(),
    ).toThrow();
  });

  it('cascades through run -> stage_execution -> artifacts/gate_decisions', () => {
    const project = seedProject();
    const pipeline = seedPipeline();
    const req = ctx.db
      .insert(requirements)
      .values({
        project_id: project.id,
        pipeline_id: pipeline.id,
        title: 't',
        description: 'd',
        source: 'manual',
        status: 'queued',
      })
      .returning()
      .all()[0];
    if (!req) throw new Error('no req');

    const run = ctx.db
      .insert(pipeline_runs)
      .values({
        requirement_id: req.id,
        pipeline_snapshot_json: pipeline.definition_json,
        per_repo_branches_json: {},
      })
      .returning()
      .all()[0];
    if (!run) throw new Error('no run');

    const exec = ctx.db
      .insert(stage_executions)
      .values({
        run_id: run.id,
        stage_name: 's1',
        status: 'running',
        events_json: [],
      })
      .returning()
      .all()[0];
    if (!exec) throw new Error('no exec');

    ctx.db
      .insert(artifacts)
      .values({
        stage_execution_id: exec.id,
        path: 'a.md',
        type: 'markdown',
        content_hash: 'sha',
        size: 1,
        storage_uri: 'mem://a',
      })
      .run();
    ctx.db
      .insert(gate_decisions)
      .values({
        stage_execution_id: exec.id,
        decided_by: 'user@x',
        decision: 'approved',
      })
      .run();

    expect(ctx.db.select().from(artifacts).all()).toHaveLength(1);
    expect(ctx.db.select().from(gate_decisions).all()).toHaveLength(1);

    // Deleting the requirement should cascade run -> stage_execution -> children.
    ctx.db.delete(requirements).where(eq(requirements.id, req.id)).run();
    expect(ctx.db.select().from(pipeline_runs).all()).toHaveLength(0);
    expect(ctx.db.select().from(stage_executions).all()).toHaveLength(0);
    expect(ctx.db.select().from(artifacts).all()).toHaveLength(0);
    expect(ctx.db.select().from(gate_decisions).all()).toHaveLength(0);
  });

  it('enforces unique (project_id, name) on repos', () => {
    const project = seedProject();
    ctx.db
      .insert(repos)
      .values({
        project_id: project.id,
        name: 'frontend',
        git_url: 'a',
        default_branch: 'main',
        working_dir: '/w',
      })
      .run();
    expect(() =>
      ctx.db
        .insert(repos)
        .values({
          project_id: project.id,
          name: 'frontend',
          git_url: 'b',
          default_branch: 'main',
          working_dir: '/w2',
        })
        .run(),
    ).toThrow();
  });

  it('enforces unique stage_execution_id on gate_decisions', () => {
    const project = seedProject();
    const pipeline = seedPipeline();
    const req = ctx.db
      .insert(requirements)
      .values({
        project_id: project.id,
        pipeline_id: pipeline.id,
        title: 't',
        description: 'd',
        source: 'manual',
        status: 'queued',
      })
      .returning()
      .all()[0];
    if (!req) throw new Error('no req');
    const run = ctx.db
      .insert(pipeline_runs)
      .values({
        requirement_id: req.id,
        pipeline_snapshot_json: pipeline.definition_json,
        per_repo_branches_json: {},
      })
      .returning()
      .all()[0];
    if (!run) throw new Error('no run');
    const exec = ctx.db
      .insert(stage_executions)
      .values({
        run_id: run.id,
        stage_name: 's',
        status: 'running',
        events_json: [],
      })
      .returning()
      .all()[0];
    if (!exec) throw new Error('no exec');

    ctx.db
      .insert(gate_decisions)
      .values({
        stage_execution_id: exec.id,
        decided_by: 'user@x',
        decision: 'approved',
      })
      .run();
    expect(() =>
      ctx.db
        .insert(gate_decisions)
        .values({
          stage_execution_id: exec.id,
          decided_by: 'user@x',
          decision: 'rejected',
        })
        .run(),
    ).toThrow();
  });

  it('enforces unique (run_id, repo_id) on pull_requests', () => {
    const project = seedProject();
    const pipeline = seedPipeline();
    const repo = ctx.db
      .insert(repos)
      .values({
        project_id: project.id,
        name: 'r',
        git_url: 'g',
        default_branch: 'main',
        working_dir: '/w',
      })
      .returning()
      .all()[0];
    if (!repo) throw new Error('no repo');
    const req = ctx.db
      .insert(requirements)
      .values({
        project_id: project.id,
        pipeline_id: pipeline.id,
        title: 't',
        description: 'd',
        source: 'manual',
        status: 'queued',
      })
      .returning()
      .all()[0];
    if (!req) throw new Error('no req');
    const run = ctx.db
      .insert(pipeline_runs)
      .values({
        requirement_id: req.id,
        pipeline_snapshot_json: pipeline.definition_json,
        per_repo_branches_json: {},
      })
      .returning()
      .all()[0];
    if (!run) throw new Error('no run');

    ctx.db
      .insert(pull_requests)
      .values({
        run_id: run.id,
        repo_id: repo.id,
        pr_url: 'x',
        pr_number: 1,
        status: 'open',
      })
      .run();
    expect(() =>
      ctx.db
        .insert(pull_requests)
        .values({
          run_id: run.id,
          repo_id: repo.id,
          pr_url: 'y',
          pr_number: 2,
          status: 'open',
        })
        .run(),
    ).toThrow();
  });
});
