/**
 * Runner integration tests for the Tier 2 cold-restart fallback (decision 4).
 *
 * The runner harness here mirrors `runner.test.ts` (scripted claudeScripts,
 * InMemoryProvider, in-memory bus). The differences are:
 *   - `runClaude` is parameterized per-call so we can fail the FIRST run of
 *     a stage and succeed the SECOND, simulating cold-restart-then-retry.
 *   - `makeSandboxProvider` is a counted spy so we can assert the runner
 *     created TWO sandboxes when cold-restart fired.
 */

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
// Fixture builders (kept self-contained from runner.test.ts so the two files
// can evolve independently).
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
  opts: {
    gate?: boolean;
    on_failure?: 'retry' | 'pause' | 'abort' | 'cold_restart';
  } = {},
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

const finishedOk: ClaudeStageEvent = {
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
  finishedOk,
];

/** Dep-failure script: a tool_result that triggers the EROFS pattern. */
const depFailureScript: ClaudeStageEvent[] = [
  {
    kind: 'session_init',
    session_id: 'sess-fail',
    model: 'claude-opus',
    tools: ['Bash'],
  },
  {
    kind: 'tool_use',
    tool: 'Bash',
    id: 'tu-1',
    input: { command: 'pnpm install dayjs' },
  },
  {
    kind: 'tool_result',
    tool_use_id: 'tu-1',
    content:
      "npm ERR! mkdir '/workspace/frontend/node_modules/dayjs': Read-only file system",
    is_error: true,
  },
  { kind: 'finished', exit_code: 1 },
];

/**
 * Build runner deps where each stage has a queue of scripts that are popped
 * one per invocation. This lets us script "fail first, succeed second" for
 * the cold-restart path.
 */
function makeStubDeps(
  fixture: Fixture,
  opts: {
    scriptsPerStage: Map<string, ClaudeStageEvent[][]>;
    onProviderCreate?: () => void;
  },
): { deps: RunnerDeps; providerCreates: number } {
  let providerCreates = 0;
  const deps: RunnerDeps = {
    db: fixture.db,
    bus: fixture.bus,
    makeSandboxProvider: () => {
      const inner = new InMemoryProvider();
      return {
        create: async (cfg) => {
          providerCreates += 1;
          opts.onProviderCreate?.();
          return inner.create(cfg);
        },
      };
    },
    injectCredentials: async () => {
      /* no-op */
    },
    bootstrapEnv: async ({ repos: rs }) => ({
      cloned: rs.map((r) => ({
        repo_id: r.id,
        working_dir: r.working_dir,
        head_sha: 'a'.repeat(40),
      })),
      failed: [],
    }),
    runClaude: ({ invocation }) => {
      const argv = invocation.argv;
      const i = argv.indexOf('--append-system-prompt');
      const systemPrompt = i >= 0 ? argv[i + 1] : undefined;
      const stageName = systemPrompt?.match(/stage:\s+([^.]+)/)?.[1]?.trim();
      const queue =
        (stageName && opts.scriptsPerStage.get(stageName)) ?? undefined;
      const script =
        queue && queue.length > 0
          ? queue.shift()!
          : Array.from(opts.scriptsPerStage.values())[0]?.[0] ?? [];
      return (async function* () {
        for (const e of script) yield e;
      })();
    },
    detectChanges: async ({ repos: rs }) =>
      rs.map((r) => ({
        repo_id: r.id,
        working_dir: r.working_dir,
        has_changes: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        changed_files: [],
      })),
    openPrs: async () => [],
    gatePollIntervalMs: 5,
  };
  return {
    deps,
    get providerCreates() {
      return providerCreates;
    },
  } as { deps: RunnerDeps; providerCreates: number };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRequirement: Tier 2 cold-restart', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = seed([makeStage('需求分析'), makeStage('实施')]);
  });

  it('triggers cold-restart when a stage fails with the dep-install signature, and re-runs the same stage', async () => {
    const stub = makeStubDeps(fix, {
      scriptsPerStage: new Map([
        ['需求分析', [happyPathScript]],
        // 实施 fails first with EROFS, then succeeds.
        ['实施', [depFailureScript, happyPathScript]],
      ]),
    });

    const result = await runRequirement(stub.deps, fix.requirementId);

    expect(result.status).toBe('completed');

    // Two sandboxes: original + cold restart.
    expect(stub.providerCreates).toBe(2);

    const kinds = fix.events.map((e) => e.event.kind);
    expect(kinds).toContain('cold_restart');
    // On the cold-restart path, `stage_failed` is intentionally NOT emitted —
    // the runner is treating the failure as recoverable and the row stays
    // open. Operators see the cold_restart event instead.
    expect(kinds).not.toContain('stage_failed');
  });

  it('on cold-restart path, run status remains running through the boundary (no run_paused / run_failed)', async () => {
    const stub = makeStubDeps(fix, {
      scriptsPerStage: new Map([
        ['需求分析', [happyPathScript]],
        ['实施', [depFailureScript, happyPathScript]],
      ]),
    });

    const result = await runRequirement(stub.deps, fix.requirementId);
    expect(result.status).toBe('completed');

    const kinds = fix.events.map((e) => e.event.kind);
    // Must not surface a paused or failed state for the in-flight stage.
    expect(kinds).not.toContain('run_paused');
    expect(kinds).not.toContain('run_failed');
    // The retry should produce stage_completed once.
    const completedFor实施 = fix.events.filter(
      (e) =>
        e.event.kind === 'stage_completed' &&
        'stage_name' in e.event &&
        e.event.stage_name === '实施',
    );
    expect(completedFor实施).toHaveLength(1);
  });

  it('a stage failure WITHOUT dep-failure pattern still pauses (regression check)', async () => {
    fix = seed([makeStage('需求分析'), makeStage('实施', { on_failure: 'pause' })]);
    const stub = makeStubDeps(fix, {
      scriptsPerStage: new Map([
        ['需求分析', [happyPathScript]],
        [
          '实施',
          [
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
        ],
      ]),
    });

    const result = await runRequirement(stub.deps, fix.requirementId);
    expect(result.status).toBe('paused');
    if (result.status === 'paused') {
      expect(result.reason).toBe('rate limited');
    }

    // Only one sandbox was created.
    expect(stub.providerCreates).toBe(1);

    const kinds = fix.events.map((e) => e.event.kind);
    expect(kinds).not.toContain('cold_restart');
    expect(kinds).toContain('run_paused');
  });

  it('on_failure="cold_restart" triggers the fallback even without a dep-failure signature', async () => {
    fix = seed([
      makeStage('需求分析'),
      makeStage('实施', { on_failure: 'cold_restart' }),
    ]);
    const stub = makeStubDeps(fix, {
      scriptsPerStage: new Map([
        ['需求分析', [happyPathScript]],
        // First call: a generic failure (no dep signature). Second: success.
        [
          '实施',
          [
            [
              {
                kind: 'session_init',
                session_id: 's',
                model: 'claude-opus',
                tools: [],
              },
              { kind: 'failed', reason: 'something else broke' },
            ],
            happyPathScript,
          ],
        ],
      ]),
    });

    const result = await runRequirement(stub.deps, fix.requirementId);
    expect(result.status).toBe('completed');

    expect(stub.providerCreates).toBe(2);

    const kinds = fix.events.map((e) => e.event.kind);
    expect(kinds).toContain('cold_restart');
  });

  it('cold-restart fires only ONCE per stage; second failure of the same stage falls through to original on_failure', async () => {
    fix = seed([makeStage('需求分析'), makeStage('实施', { on_failure: 'pause' })]);
    const stub = makeStubDeps(fix, {
      scriptsPerStage: new Map([
        ['需求分析', [happyPathScript]],
        // Fail with dep-signature TWICE.
        ['实施', [depFailureScript, depFailureScript]],
      ]),
    });

    const result = await runRequirement(stub.deps, fix.requirementId);

    // Run should be paused (the original `on_failure='pause'`), not
    // completed and not infinitely cold-restarting.
    expect(result.status).toBe('paused');

    // Two sandboxes: the original + ONE cold restart. Not three.
    expect(stub.providerCreates).toBe(2);

    const coldRestartEvents = fix.events.filter(
      (e) => e.event.kind === 'cold_restart',
    );
    expect(coldRestartEvents).toHaveLength(1);
  });

  it('persists a synthetic cold_restart event into the failing stage row’s events_json', async () => {
    const stub = makeStubDeps(fix, {
      scriptsPerStage: new Map([
        ['需求分析', [happyPathScript]],
        ['实施', [depFailureScript, happyPathScript]],
      ]),
    });

    const result = await runRequirement(stub.deps, fix.requirementId);
    expect(result.status).toBe('completed');

    const run = pipeline_runs.getRunByRequirement(fix.db, fix.requirementId)!;
    const allRows = fix.db
      .select()
      .from((await import('../db/schema.js')).stage_executions)
      .all()
      .filter((s) => s.run_id === run.id);

    // 需求分析 + 实施 (failed-then-restarted) + 实施 (retry) = 3 rows.
    expect(allRows.length).toBeGreaterThanOrEqual(3);

    // The first 实施 row carries the cold_restart synthetic event AND has
    // been finalized as `failed` (no orphan rows left at status=running).
    const 实施Rows = allRows
      .filter((r) => r.stage_name === '实施')
      .sort((a, b) => a.started_at - b.started_at);
    expect(实施Rows.length).toBe(2);
    const firstRow = 实施Rows[0]!;
    const types = firstRow.events_json.map((e) => e.type);
    expect(types).toContain('cold_restart');
    expect(firstRow.status).toBe('failed');
    expect(firstRow.finished_at).toBeTypeOf('number');

    // The retry row is the one that actually completed.
    const secondRow = 实施Rows[1]!;
    expect(secondRow.status).toBe('completed');
    expect(secondRow.finished_at).toBeTypeOf('number');
  });

  it('publishes the cold_restart event with the expected shape', async () => {
    const stub = makeStubDeps(fix, {
      scriptsPerStage: new Map([
        ['需求分析', [happyPathScript]],
        ['实施', [depFailureScript, happyPathScript]],
      ]),
    });

    await runRequirement(stub.deps, fix.requirementId);

    const coldRestart = fix.events.find(
      (e) => e.event.kind === 'cold_restart',
    );
    expect(coldRestart).toBeDefined();
    if (coldRestart && coldRestart.event.kind === 'cold_restart') {
      expect(coldRestart.event.stage_name).toBe('实施');
      expect(coldRestart.event.run_id).toBeTypeOf('string');
      expect(coldRestart.event.at).toBeTypeOf('string');
      expect(coldRestart.event.reason).toContain('dep-install');
    }
  });

  it('snapshots and restores prior-stage artifacts across the cold-restart boundary', async () => {
    // Setup: stage 需求分析 writes an artifact via `session.writeFile`.
    // Stage 实施 first fails with EROFS (triggering cold-restart), then
    // succeeds. On the SECOND (cold) invocation of 实施, we read the
    // artifact path back through `session.readFile` and capture the result.
    // If snapshot/restore worked, the read succeeds with the original bytes.
    const fixture = seed([makeStage('需求分析'), makeStage('实施')]);
    let providerCreates = 0;
    const enc = new TextEncoder();
    const PRD_PATH = '/workspace/.auto-finish/artifacts/需求分析/prd.md';
    const PRD_BODY = '# PRD\nSurvived cold-restart';
    const stage实施ScriptQueue: ClaudeStageEvent[][] = [
      depFailureScript,
      happyPathScript,
    ];
    let prdReadbackOnRetry: string | null = null;
    let prdReadbackError: string | null = null;

    const deps: RunnerDeps = {
      db: fixture.db,
      bus: fixture.bus,
      makeSandboxProvider: () => {
        const inner = new InMemoryProvider();
        return {
          create: async (cfg) => {
            providerCreates += 1;
            return inner.create(cfg);
          },
        };
      },
      injectCredentials: async () => {},
      bootstrapEnv: async ({ repos: rs }) => ({
        cloned: rs.map((r) => ({
          repo_id: r.id,
          working_dir: r.working_dir,
          head_sha: 'a'.repeat(40),
        })),
        failed: [],
      }),
      runClaude: ({ invocation, session }) => {
        const argv = invocation.argv;
        const i = argv.indexOf('--append-system-prompt');
        const sp = i >= 0 ? argv[i + 1] : undefined;
        const stageName = sp?.match(/stage:\s+([^.]+)/)?.[1]?.trim();
        return (async function* () {
          if (stageName === '需求分析') {
            for (const e of happyPathScript) {
              if (e.kind === 'finished') {
                // Drop the artifact just before finishing.
                await session.writeFile(PRD_PATH, enc.encode(PRD_BODY));
              }
              yield e;
            }
            return;
          }
          if (stageName === '实施') {
            const script = stage实施ScriptQueue.shift() ?? happyPathScript;
            // Detect retry by reading the artifact in the (cold) sandbox at
            // the top of the second call. If snapshot/restore worked, it's
            // present; otherwise readFile throws.
            if (script === happyPathScript) {
              try {
                const bytes = await session.readFile(PRD_PATH);
                prdReadbackOnRetry = new TextDecoder().decode(bytes);
              } catch (e) {
                prdReadbackError = e instanceof Error ? e.message : String(e);
              }
            }
            for (const e of script) yield e;
            return;
          }
          for (const e of happyPathScript) yield e;
        })();
      },
      detectChanges: async ({ repos: rs }) =>
        rs.map((r) => ({
          repo_id: r.id,
          working_dir: r.working_dir,
          has_changes: false,
          files_changed: 0,
          insertions: 0,
          deletions: 0,
          changed_files: [],
        })),
      openPrs: async () => [],
      gatePollIntervalMs: 5,
    };

    const result = await runRequirement(deps, fixture.requirementId);
    expect(result.status).toBe('completed');
    expect(providerCreates).toBe(2);

    // The PRD must have been readable in the COLD (post-restart) sandbox —
    // proving snapshot + restore round-tripped through the boundary.
    expect(prdReadbackError).toBeNull();
    expect(prdReadbackOnRetry).toBe(PRD_BODY);
  });
});
