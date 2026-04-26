import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInMemoryDb,
  runMigrations,
  projects,
  repos,
  pipelines,
  requirements,
  pipeline_runs,
  stage_executions,
  gate_decisions,
  pull_requests,
} from '../db/index.js';
import type { Db } from '../db/index.js';
import { EventBus } from '../eventbus/index.js';
import type { BusMessage } from '../eventbus/index.js';
import { InMemoryProvider } from '../sandbox/in-memory-provider.js';
import type { ClaudeStageEvent } from '../claude/stage-event.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';
import { runRequirement } from './runner.js';
import type { RunnerDeps } from './types.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildPipeline(stages: Pipeline['stages']): Pipeline {
  return {
    id: 'test-pipe',
    name: 'Test Pipeline',
    version: '1.0.0',
    stages,
  } as Pipeline;
}

function makeStage(
  name: string,
  opts: { gate?: boolean; on_failure?: 'retry' | 'pause' | 'abort' } = {},
): Pipeline['stages'][number] {
  return {
    name,
    agent_config: {
      system_prompt: `You are running stage: ${name}.`,
      allowed_tools: ['Read', 'Write'],
      add_dirs: ['/workspace'],
    },
    artifacts: [],
    on_failure: opts.on_failure ?? 'pause',
    ...(opts.gate
      ? { gate: { required: true, review_targets: [`artifacts/${name}.md`] } }
      : {}),
  } as Pipeline['stages'][number];
}

interface Fixture {
  db: Db;
  bus: EventBus;
  events: BusMessage[];
  requirementId: string;
  pipelineId: string;
}

function seed(stages: Pipeline['stages']): Fixture {
  const handle = createInMemoryDb();
  runMigrations(handle.db);
  const db = handle.db;

  const project = projects.createProject(db, {
    name: 'Demo',
    description: 'demo',
    default_pipeline_id: null,
    sandbox_config_json: { image: 'node:20' },
    claude_config_json: { credentials_source: 'host_mount' },
  });

  repos.addRepo(db, {
    project_id: project.id,
    name: 'frontend',
    git_url: 'https://github.com/example/frontend.git',
    default_branch: 'main',
    working_dir: '/workspace/frontend',
    test_command: 'npm test',
    pr_template: null,
  });

  const pipeline = pipelines.createPipeline(db, {
    name: 'Test',
    version: '1.0.0',
    definition_json: buildPipeline(stages),
  });

  const req = requirements.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: 'add /health endpoint',
    description: 'expose a /health endpoint and a UI indicator',
    source: 'manual',
    source_ref: null,
    status: 'queued',
    current_stage_id: null,
  });

  const bus = new EventBus();
  const events: BusMessage[] = [];
  bus.subscribe('*', (msg) => {
    events.push(msg);
  });

  return { db, bus, events, requirementId: req.id, pipelineId: pipeline.id };
}

/** Build the minimal RunnerDeps with everything stubbed, suitable for tests. */
interface StubDepsOpts {
  /** Yields per-stage scripted events. Indexed by stage name. */
  claudeScripts: Map<string, ClaudeStageEvent[]>;
  /** Repos with diffs for the PR phase. Default: none. */
  changedRepoIds?: string[];
}

function makeStubDeps(
  fixture: Fixture,
  opts: StubDepsOpts,
): RunnerDeps {
  return {
    db: fixture.db,
    bus: fixture.bus,
    makeSandboxProvider: () => new InMemoryProvider(),
    injectCredentials: async () => {
      /* no-op in tests */
    },
    bootstrapEnv: async ({ repos: rs }) => {
      return {
        cloned: rs.map((r) => ({
          repo_id: r.id,
          working_dir: r.working_dir,
          head_sha: 'a'.repeat(40),
        })),
        failed: [],
      };
    },
    runClaude: ({ invocation }) => {
      const argv = invocation.argv;
      const i = argv.indexOf('--append-system-prompt');
      const systemPrompt = i >= 0 ? argv[i + 1] : undefined;
      const stageName = systemPrompt?.match(/stage:\s+([^.]+)/)?.[1]?.trim();
      const script =
        (stageName && opts.claudeScripts.get(stageName)) ??
        Array.from(opts.claudeScripts.values())[0] ??
        [];
      return (async function* () {
        for (const e of script) {
          yield e;
        }
      })();
    },
    detectChanges: async ({ repos: rs }) => {
      const changed = new Set(opts.changedRepoIds ?? []);
      return rs.map((r) => ({
        repo_id: r.id,
        working_dir: r.working_dir,
        has_changes: changed.has(r.id),
        files_changed: changed.has(r.id) ? 1 : 0,
        insertions: changed.has(r.id) ? 1 : 0,
        deletions: 0,
        changed_files: changed.has(r.id) ? ['README.md'] : [],
      }));
    },
    openPrs: async ({ perRepo }) => {
      return perRepo
        .filter((entry) => entry.diff.has_changes)
        .map((entry, idx) => ({
          repo_id: entry.repo.id,
          pr_url: `https://github.com/example/${entry.repo.name}/pull/${idx + 1}`,
          pr_number: idx + 1,
        }));
    },
    gatePollIntervalMs: 5,
  };
}

const finishedEvent: ClaudeStageEvent = {
  kind: 'finished',
  exit_code: 0,
  total_cost_usd: 0.001,
  num_turns: 1,
  duration_ms: 100,
};

const happyPathScript: ClaudeStageEvent[] = [
  {
    kind: 'session_init',
    session_id: 'sess-1',
    model: 'claude-opus',
    tools: ['Read', 'Write'],
  },
  { kind: 'assistant_text', text: 'doing the work' },
  finishedEvent,
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRequirement', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = seed([makeStage('需求分析'), makeStage('方案设计')]);
  });

  it('runs a 2-stage pipeline with no gates to completion', async () => {
    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        ['方案设计', happyPathScript],
      ]),
    });

    const result = await runRequirement(deps, fix.requirementId);

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.prs).toEqual([]);
    }

    const updatedReq = requirements.getRequirement(fix.db, fix.requirementId);
    expect(updatedReq?.status).toBe('completed');

    const run = pipeline_runs.getRunByRequirement(fix.db, fix.requirementId);
    expect(run).toBeDefined();
    expect(run?.finished_at).toBeTypeOf('number');

    const stageNames = fix.events.map((e) => e.event.kind);
    expect(stageNames).toContain('run_started');
    expect(stageNames).toContain('stage_started');
    expect(stageNames).toContain('stage_completed');
    expect(stageNames).toContain('run_completed');
  });

  it('opens PRs for repos with diffs', async () => {
    const repoRows = repos.listReposForProject(
      fix.db,
      requirements.getRequirement(fix.db, fix.requirementId)!.project_id,
    );
    const frontendRepo = repoRows[0]!;

    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        ['方案设计', happyPathScript],
      ]),
      changedRepoIds: [frontendRepo.id],
    });

    const result = await runRequirement(deps, fix.requirementId);

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.prs).toHaveLength(1);
      expect(result.prs[0]?.repo_id).toBe(frontendRepo.id);
    }

    const run = pipeline_runs.getRunByRequirement(fix.db, fix.requirementId)!;
    const persistedPrs = pull_requests.listPRsForRun(fix.db, run.id);
    expect(persistedPrs).toHaveLength(1);
    expect(persistedPrs[0]?.pr_url).toContain('frontend/pull/1');
  });

  it('blocks at a gate and resumes on approval', async () => {
    fix = seed([
      makeStage('需求分析'),
      makeStage('方案设计', { gate: true }),
      makeStage('实施'),
    ]);

    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        ['方案设计', happyPathScript],
        ['实施', happyPathScript],
      ]),
    });

    const runPromise = runRequirement(deps, fix.requirementId);

    // Wait until gate_required is published.
    await new Promise<void>((resolve) => {
      const unsub = fix.bus.subscribe('*', (msg) => {
        if (msg.event.kind === 'gate_required') {
          unsub();
          resolve();
        }
      });
    });

    const reqMid = requirements.getRequirement(fix.db, fix.requirementId)!;
    expect(reqMid.status).toBe('awaiting_gate');

    // Approve via DB (the HTTP gate endpoint normally does this).
    const stageExecs = fix.db
      .select()
      .from((await import('../db/schema.js')).stage_executions)
      .all();
    const gatedStage = stageExecs.find((s) => s.stage_name === '方案设计')!;
    gate_decisions.recordDecision(fix.db, {
      stage_execution_id: gatedStage.id,
      decided_by: 'tester',
      decision: 'approved',
      feedback: null,
    });

    const result = await runPromise;

    expect(result.status).toBe('completed');

    const updatedReq = requirements.getRequirement(fix.db, fix.requirementId);
    expect(updatedReq?.status).toBe('completed');

    const kinds = fix.events.map((e) => e.event.kind);
    expect(kinds).toContain('gate_required');
    expect(kinds).toContain('gate_decided');
    expect(kinds).toContain('run_completed');
  });

  it('returns awaiting_changes when gate is rejected', async () => {
    fix = seed([
      makeStage('需求分析'),
      makeStage('方案设计', { gate: true }),
      makeStage('实施'),
    ]);

    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        ['方案设计', happyPathScript],
        ['实施', happyPathScript],
      ]),
    });

    const runPromise = runRequirement(deps, fix.requirementId);

    await new Promise<void>((resolve) => {
      const unsub = fix.bus.subscribe('*', (msg) => {
        if (msg.event.kind === 'gate_required') {
          unsub();
          resolve();
        }
      });
    });

    const stageExecs = fix.db
      .select()
      .from((await import('../db/schema.js')).stage_executions)
      .all();
    const gatedStage = stageExecs.find((s) => s.stage_name === '方案设计')!;
    gate_decisions.recordDecision(fix.db, {
      stage_execution_id: gatedStage.id,
      decided_by: 'tester',
      decision: 'rejected',
      feedback: 'design unclear, needs more detail on data flow',
    });

    const result = await runPromise;

    expect(result.status).toBe('awaiting_changes');
    if (result.status === 'awaiting_changes') {
      expect(result.feedback).toContain('design unclear');
    }

    const updatedReq = requirements.getRequirement(fix.db, fix.requirementId);
    expect(updatedReq?.status).toBe('awaiting_changes');

    // 实施 stage must NOT have been executed.
    const stageExecsAfter = stage_executions
      ? fix.db
          .select()
          .from((await import('../db/schema.js')).stage_executions)
          .all()
      : [];
    expect(stageExecsAfter.find((s) => s.stage_name === '实施')).toBeUndefined();
  });

  it('marks the run as paused when a stage fails with on_failure=pause', async () => {
    fix = seed([
      makeStage('需求分析'),
      makeStage('方案设计', { on_failure: 'pause' }),
    ]);

    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        [
          '方案设计',
          [
            {
              kind: 'session_init',
              session_id: 's',
              model: 'claude-opus',
              tools: [],
            },
            { kind: 'failed', reason: 'rate limited' },
          ],
        ],
      ]),
    });

    const result = await runRequirement(deps, fix.requirementId);

    expect(result.status).toBe('paused');
    if (result.status === 'paused') {
      expect(result.stage_name).toBe('方案设计');
      expect(result.reason).toBe('rate limited');
    }

    const updatedReq = requirements.getRequirement(fix.db, fix.requirementId);
    expect(updatedReq?.status).toBe('paused');

    const kinds = fix.events.map((e) => e.event.kind);
    expect(kinds).toContain('stage_failed');
    expect(kinds).toContain('run_paused');
  });

  it('marks the run as failed when a stage fails with on_failure=abort', async () => {
    fix = seed([
      makeStage('需求分析'),
      makeStage('方案设计', { on_failure: 'abort' }),
    ]);

    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        [
          '方案设计',
          [
            {
              kind: 'session_init',
              session_id: 's',
              model: 'claude-opus',
              tools: [],
            },
            { kind: 'failed', reason: 'fatal error' },
          ],
        ],
      ]),
    });

    const result = await runRequirement(deps, fix.requirementId);

    expect(result.status).toBe('failed');
    const updatedReq = requirements.getRequirement(fix.db, fix.requirementId);
    expect(updatedReq?.status).toBe('failed');

    const kinds = fix.events.map((e) => e.event.kind);
    expect(kinds).toContain('run_failed');
  });

  it('persists claude_session_id from session_init onto the stage_executions row', async () => {
    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        ['方案设计', happyPathScript],
      ]),
    });

    const result = await runRequirement(deps, fix.requirementId);
    expect(result.status).toBe('completed');

    const run = pipeline_runs.getRunByRequirement(fix.db, fix.requirementId)!;
    const stages = fix.db
      .select()
      .from((await import('../db/schema.js')).stage_executions)
      .all()
      .filter((s) => s.run_id === run.id);
    expect(stages.length).toBeGreaterThan(0);
    // Every stage that emitted a session_init should have its session_id
    // lifted to the row column. The fixture's `happyPathScript` uses
    // `session_id: 'sess-1'`.
    for (const s of stages) {
      expect(s.claude_session_id).toBe('sess-1');
    }
  });

  it('emits gate_required BEFORE stage_completed for gated stages, and skips stage_completed on rejection (Fix #13)', async () => {
    fix = seed([
      makeStage('需求分析'),
      makeStage('方案设计', { gate: true }),
      makeStage('实施'),
    ]);

    const deps = makeStubDeps(fix, {
      claudeScripts: new Map([
        ['需求分析', happyPathScript],
        ['方案设计', happyPathScript],
        ['实施', happyPathScript],
      ]),
    });

    const runPromise = runRequirement(deps, fix.requirementId);

    await new Promise<void>((resolve) => {
      const unsub = fix.bus.subscribe('*', (msg) => {
        if (msg.event.kind === 'gate_required') {
          unsub();
          resolve();
        }
      });
    });

    // Inspect events at the moment the gate is required: the gated stage
    // (方案设计) must NOT yet have a stage_completed event.
    const gatedStage = '方案设计';
    const completedBeforeGate = fix.events.some(
      (e) =>
        e.event.kind === 'stage_completed' &&
        'stage_name' in e.event &&
        e.event.stage_name === gatedStage,
    );
    expect(completedBeforeGate).toBe(false);

    // Reject the gate.
    const stageExecs = fix.db
      .select()
      .from((await import('../db/schema.js')).stage_executions)
      .all();
    const gated = stageExecs.find((s) => s.stage_name === gatedStage)!;
    gate_decisions.recordDecision(fix.db, {
      stage_execution_id: gated.id,
      decided_by: 'tester',
      decision: 'rejected',
      feedback: 'rework',
    });

    const result = await runPromise;
    expect(result.status).toBe('awaiting_changes');

    // No stage_completed for the gated stage on the rejection path.
    const finalCompleted = fix.events.filter(
      (e) =>
        e.event.kind === 'stage_completed' &&
        'stage_name' in e.event &&
        e.event.stage_name === gatedStage,
    );
    expect(finalCompleted).toHaveLength(0);

    // gate_decided was emitted.
    const gateDecided = fix.events.filter(
      (e) => e.event.kind === 'gate_decided',
    );
    expect(gateDecided).toHaveLength(1);
  });

  it('resumes from a gate via bus signal much faster than poll interval (Fix #11)', async () => {
    fix = seed([
      makeStage('需求分析'),
      makeStage('方案设计', { gate: true }),
      makeStage('实施'),
    ]);

    const deps: RunnerDeps = {
      ...makeStubDeps(fix, {
        claudeScripts: new Map([
          ['需求分析', happyPathScript],
          ['方案设计', happyPathScript],
          ['实施', happyPathScript],
        ]),
      }),
      // Set the DB poll interval extremely high so the test fails if the
      // runner is using the polling path. The bus signal must win.
      gatePollIntervalMs: 60_000,
    };

    const runPromise = runRequirement(deps, fix.requirementId);

    // Wait for gate_required.
    await new Promise<void>((resolve) => {
      const unsub = fix.bus.subscribe('*', (msg) => {
        if (msg.event.kind === 'gate_required') {
          unsub();
          resolve();
        }
      });
    });

    // Lookup run id + stage name once gate is up.
    const run = pipeline_runs.getRunByRequirement(fix.db, fix.requirementId)!;
    const stageExecs = fix.db
      .select()
      .from((await import('../db/schema.js')).stage_executions)
      .all();
    const gated = stageExecs.find((s) => s.stage_name === '方案设计')!;

    // Record the decision in the DB (HTTP route does this in production)
    // and publish the bus signal that the route would publish.
    gate_decisions.recordDecision(fix.db, {
      stage_execution_id: gated.id,
      decided_by: 'tester',
      decision: 'approved',
      feedback: null,
    });
    const before = Date.now();
    fix.bus.publish({
      topic: `run:${run.id}`,
      event: {
        kind: 'gate_decided',
        run_id: run.id,
        stage_name: '方案设计',
        decision: 'approved',
      },
      emitted_at: new Date().toISOString(),
    });

    const result = await runPromise;
    const elapsed = Date.now() - before;

    expect(result.status).toBe('completed');
    // 60s poll interval; if we got here in well under that, the bus path
    // beat the poll loop. Allow generous slack for slow CI machines.
    expect(elapsed).toBeLessThan(2_000);
  });
});
