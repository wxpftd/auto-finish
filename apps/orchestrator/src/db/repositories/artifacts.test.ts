import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInMemoryDb,
  runMigrations,
  type Db,
  projects,
  pipelines,
  requirements,
  pipeline_runs,
  stage_executions,
} from '../index.js';
import {
  createArtifact,
  getArtifact,
  listArtifactsForRun,
  listArtifactsForStage,
  isInlineArtifact,
  ARTIFACT_INLINE_URI,
} from './artifacts.js';

interface Fixture {
  db: Db;
  stageId1: string;
  stageId2: string;
  runId: string;
}

beforeEach(() => {});

function setup(): Fixture {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  const db = handle.db;
  const project = projects.createProject(db, {
    name: 'p',
    sandbox_config_json: {
      provider: 'in_memory',
      warm_strategy: 'cold_only',
    },
    claude_config_json: { credentials_source: 'host_mount' },
  });
  const pipeline = pipelines.createPipeline(db, {
    project_id: project.id,
    name: 'pipe',
    version: '1',
    definition_json: {
      id: 'pipe',
      name: 'pipe',
      version: '1',
      stages: [{ name: 's1', agent_config: {} }],
    },
  });
  const req = requirements.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: 't',
    description: 'd',
    source: 'manual',
    status: 'queued',
    current_stage_id: null,
  });
  const run = pipeline_runs.createRun(db, {
    requirement_id: req.id,
    pipeline_snapshot_json: pipeline.definition_json,
    sandbox_session_id: 'sess',
    per_repo_branches_json: {},
  });
  const s1 = stage_executions.createStageExecution(db, {
    run_id: run.id,
    stage_name: 's1',
    status: 'running',
  });
  const s2 = stage_executions.createStageExecution(db, {
    run_id: run.id,
    stage_name: 's2',
    status: 'running',
  });
  return { db, stageId1: s1.id, stageId2: s2.id, runId: run.id };
}

describe('artifacts repository', () => {
  it('createArtifact computes content_hash and size from inline content', () => {
    const { db, stageId1 } = setup();
    const a = createArtifact(db, {
      stage_execution_id: stageId1,
      path: 'foo.diff',
      type: 'diff',
      preview: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
      content: 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new',
      storage_uri: ARTIFACT_INLINE_URI,
    });
    expect(a.id).toBeDefined();
    expect(a.size).toBeGreaterThan(0);
    expect(a.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.created_at).toBeGreaterThan(0);
    expect(isInlineArtifact(a)).toBe(true);
  });

  it('createArtifact accepts explicit content_hash + size for offsite blobs', () => {
    const { db, stageId1 } = setup();
    const a = createArtifact(db, {
      stage_execution_id: stageId1,
      path: 'big.bin',
      type: 'binary',
      content_hash: 'a'.repeat(64),
      size: 1_048_576,
      preview: null,
      storage_uri: 's3://bucket/key',
    });
    expect(a.content_hash).toBe('a'.repeat(64));
    expect(a.size).toBe(1_048_576);
    expect(isInlineArtifact(a)).toBe(false);
  });

  it('createArtifact rejects when neither content nor (hash+size) supplied', () => {
    const { db, stageId1 } = setup();
    expect(() =>
      createArtifact(db, {
        stage_execution_id: stageId1,
        path: 'x',
        type: 't',
        storage_uri: 'inline://',
      }),
    ).toThrow(/content/);
  });

  it('listArtifactsForStage returns this stage only, ordered by created_at', () => {
    const { db, stageId1, stageId2 } = setup();
    const a1 = createArtifact(db, {
      stage_execution_id: stageId1,
      path: 'a.diff',
      type: 'diff',
      content: 'a',
      storage_uri: 'inline://',
    });
    createArtifact(db, {
      stage_execution_id: stageId2,
      path: 'b.diff',
      type: 'diff',
      content: 'b',
      storage_uri: 'inline://',
    });
    const a3 = createArtifact(db, {
      stage_execution_id: stageId1,
      path: 'c.diff',
      type: 'diff',
      content: 'c',
      storage_uri: 'inline://',
    });
    const list = listArtifactsForStage(db, stageId1);
    expect(list.map((a) => a.id)).toEqual([a1.id, a3.id]);
  });

  it('listArtifactsForRun joins through stage_executions', () => {
    const { db, runId, stageId1, stageId2 } = setup();
    createArtifact(db, {
      stage_execution_id: stageId1,
      path: 'a.diff',
      type: 'diff',
      content: 'a',
      storage_uri: 'inline://',
    });
    createArtifact(db, {
      stage_execution_id: stageId2,
      path: 'b.diff',
      type: 'diff',
      content: 'b',
      storage_uri: 'inline://',
    });
    const list = listArtifactsForRun(db, runId);
    expect(list.length).toBe(2);
    expect(list.map((a) => a.path).sort()).toEqual(['a.diff', 'b.diff']);
  });

  it('getArtifact returns by id', () => {
    const { db, stageId1 } = setup();
    const a = createArtifact(db, {
      stage_execution_id: stageId1,
      path: 'x',
      type: 'text',
      content: 'hello',
      storage_uri: 'inline://',
    });
    const back = getArtifact(db, a.id);
    expect(back?.id).toBe(a.id);
    expect(back?.preview).toBeNull();
  });
});
