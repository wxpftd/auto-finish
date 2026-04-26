/**
 * Real-link end-to-end test for the orchestrator → WS bridge → dashboard
 * reducer chain.
 *
 * Why this lives in apps/orchestrator (and not apps/dashboard)
 * -----------------------------------------------------------
 * The test needs all three of:
 *   - the real `startServer` (HTTP + WebSocket bootstrap, in apps/orchestrator)
 *   - the real `runRequirement` driving an in-memory provider (apps/orchestrator)
 *   - the dashboard's `connectWs` and `reduceEvent` (apps/dashboard)
 *
 * The orchestrator side has the heavy native deps (`better-sqlite3`,
 * `@hono/node-server`, the in-memory sandbox provider) and the `ws` package.
 * Dashboard owns no orchestrator code. So we keep the test on the
 * orchestrator side and pull the dashboard reducer + ws client across the
 * workspace via a relative import — the dashboard reducer is pure TS with
 * no SvelteKit-specific deps; `ws.ts` only imports `$env/dynamic/public`,
 * which we stub via the alias added in `apps/orchestrator/vitest.config.ts`
 * (mirroring the alias the dashboard's vitest config already uses).
 *
 * What this verifies
 * ------------------
 *   1. A real Hono server with the WS bridge mounted on the same port can
 *      forward `PipelineEvent` envelopes published on the in-process
 *      `EventBus` to a connected `connectWs` client.
 *   2. Routed through the real `reduceEvent`, the dashboard's view state
 *      evolves correctly across the canonical happy path
 *      (`run_started → stage_started → stage_completed → run_completed`)
 *      AND the gate flow (`gate_required → gate_decided → run_completed`).
 *   3. Reconnect: when the server forcibly closes a client socket, the
 *      `ws.ts` exponential-backoff reconnect path opens a new socket,
 *      re-subscribes, and continues to receive events that the reducer
 *      applies on top of the prior state.
 *
 * Why an in-memory provider + scripted Claude
 * -------------------------------------------
 * Mirrors `runner.test.ts`: the runner is pluggable, and we use the
 * `InMemoryProvider` + a stubbed `runClaude` that yields a fixed
 * `ClaudeStageEvent` script. This keeps the test under 1s on a laptop —
 * fast enough to run under the default `pnpm -r test`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';

import {
  createInMemoryDb,
  runMigrations,
  projects,
  repos,
  pipelines,
  requirements,
  pipeline_runs,
  gate_decisions,
} from '../db/index.js';
import type { Db } from '../db/index.js';
import { stage_executions as stageExecutionsTable } from '../db/schema.js';
import { EventBus } from '../eventbus/index.js';
import { InMemoryProvider } from '../sandbox/in-memory-provider.js';
import { runRequirement } from '../runner/runner.js';
import type { RunnerDeps } from '../runner/types.js';
import type { ClaudeStageEvent } from '../claude/stage-event.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';
import { startServer, type ServerHandle } from './server.js';

// Dashboard imports — exercised, not copied. Relative paths reach across the
// workspace into apps/dashboard.
import {
  reduceEvent,
  type EventViewState,
} from '../../../dashboard/src/lib/api/event-reducer.js';
import {
  connectWs,
  type WebSocketLike,
  type WsClientHandle,
} from '../../../dashboard/src/lib/api/ws.js';
import type {
  PipelineEvent as DashboardPipelineEvent,
  StageExecution as DashboardStageExecution,
} from '../../../dashboard/src/lib/api/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  db: Db;
  bus: EventBus;
  requirementId: string;
  pipelineId: string;
}

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
  opts: { gate?: boolean } = {},
): Pipeline['stages'][number] {
  return {
    name,
    agent_config: {
      system_prompt: `You are running stage: ${name}.`,
      allowed_tools: ['Read', 'Write'],
      add_dirs: ['/workspace'],
    },
    artifacts: [],
    on_failure: 'pause',
    ...(opts.gate
      ? { gate: { required: true, review_targets: [`artifacts/${name}.md`] } }
      : {}),
  } as Pipeline['stages'][number];
}

/**
 * Seed a fresh in-memory DB with one project, one repo, one pipeline, and
 * one queued requirement. Returns the EventBus the runner should use AND
 * the same EventBus is what we'll inject into `startServer` so events
 * published by the runner reach WS subscribers without going through HTTP.
 */
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

  return {
    db,
    bus: new EventBus(),
    requirementId: req.id,
    pipelineId: pipeline.id,
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

function makeRunnerDeps(
  fix: Fixture,
  scripts: Map<string, ClaudeStageEvent[]>,
): RunnerDeps {
  return {
    db: fix.db,
    bus: fix.bus,
    makeSandboxProvider: () => new InMemoryProvider(),
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
      const sys = i >= 0 ? argv[i + 1] : undefined;
      const stageName = sys?.match(/stage:\s+([^.]+)/)?.[1]?.trim();
      const script =
        (stageName && scripts.get(stageName)) ??
        Array.from(scripts.values())[0] ??
        [];
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
}

function emptyState(stageNames: string[]): EventViewState {
  const stages: DashboardStageExecution[] = stageNames.map((name, i) => ({
    id: `placeholder-${i}`,
    run_id: 'placeholder-run',
    stage_name: name,
    status: 'pending',
    claude_subprocess_pid: null,
    claude_session_id: null,
    started_at: 0,
    finished_at: null,
    events_json: [],
  }));
  return {
    log: [],
    liveStatus: 'queued',
    currentStage: null,
    stages,
  };
}

/**
 * Cast `ws`'s WebSocket to the `WebSocketLike` shape the dashboard client
 * expects. ws@8 is WHATWG-compliant: it exposes `OPEN`/`CLOSED`/`CONNECTING`/
 * `CLOSING` static fields and `addEventListener`. The cast goes through
 * `unknown` to satisfy the strict overload typing in `WebSocketLike` — same
 * pattern the dashboard's own ws.test.ts uses for its mock.
 */
const wsImpl = WsWebSocket as unknown as WebSocketLike;

/** Wait until `predicate(state)` becomes true or the time budget elapses. */
async function waitFor(
  getState: () => EventViewState,
  predicate: (s: EventViewState) => boolean,
  timeoutMs = 2000,
): Promise<EventViewState> {
  const start = Date.now();
  // Polling cadence small enough to keep the test snappy but large enough to
  // not starve the event loop. 5ms matches gatePollIntervalMs in test deps.
  while (Date.now() - start < timeoutMs) {
    const s = getState();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitFor: timed out after ${timeoutMs}ms; last state: ${JSON.stringify({
      liveStatus: getState().liveStatus,
      currentStage: getState().currentStage,
      stagesStatus: getState().stages.map((s) => `${s.stage_name}:${s.status}`),
      logTail: getState().log.slice(-3).map((l) => l.line),
    })}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('realtime e2e: orchestrator WS bridge → dashboard reducer', () => {
  let server: ServerHandle | null = null;
  let client: WsClientHandle | null = null;

  beforeEach(() => {
    server = null;
    client = null;
  });

  afterEach(async () => {
    if (client !== null) {
      client.close();
      client = null;
    }
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  it('streams a 2-stage no-gate run end-to-end and reduces to terminal state', async () => {
    const fix = seed([makeStage('design'), makeStage('implement')]);

    // Inject the runner's bus into the server so events the runner publishes
    // on `bus` reach WS subscribers via the bridge attached inside startServer.
    server = await startServer({
      port: 0,
      dbPath: ':memory:',
      bus: fix.bus,
    });

    // Reducer state lives outside the client callback; the callback feeds it.
    let state = emptyState(['design', 'implement']);
    const onEvent = (ev: DashboardPipelineEvent): void => {
      state = reduceEvent(state, ev, Date.now());
    };

    client = connectWs({
      baseUrl: server.url.replace(/^http/, 'ws'),
      filter: '*',
      onEvent,
      WebSocketImpl: wsImpl,
      // Tight backoff so the reconnect test below doesn't pad the suite.
      reconnectInitialDelayMs: 25,
      maxReconnectAttempts: 5,
    });

    // The runner publishes immediately, so subscribe BEFORE starting it.
    await client.ready;

    const result = await runRequirement(
      makeRunnerDeps(
        fix,
        new Map([
          ['design', happyPathScript],
          ['implement', happyPathScript],
        ]),
      ),
      fix.requirementId,
    );
    expect(result.status).toBe('completed');

    // The reducer is fed asynchronously over a real socket — wait for the
    // terminal event before asserting.
    const finalState = await waitFor(
      () => state,
      (s) => s.liveStatus === 'done',
    );

    // run_started → liveStatus 'running'
    // stage_started → currentStage set, stages[].status 'running'
    // stage_completed → stages[].status 'succeeded'
    // run_completed → liveStatus 'done'
    expect(finalState.liveStatus).toBe('done');
    const designStage = finalState.stages.find(
      (s) => s.stage_name === 'design',
    );
    const implementStage = finalState.stages.find(
      (s) => s.stage_name === 'implement',
    );
    expect(designStage?.status).toBe('succeeded');
    expect(implementStage?.status).toBe('succeeded');

    // The log timeline must include each canonical event in order.
    const lines = finalState.log.map((e) => e.line);
    const idxRunStarted = lines.indexOf('run started');
    const idxDesignStarted = lines.indexOf('stage started: design');
    const idxImplementStarted = lines.indexOf('stage started: implement');
    const idxRunCompleted = lines.indexOf('run completed');
    expect(idxRunStarted).toBeGreaterThanOrEqual(0);
    expect(idxDesignStarted).toBeGreaterThan(idxRunStarted);
    expect(idxImplementStarted).toBeGreaterThan(idxDesignStarted);
    expect(idxRunCompleted).toBeGreaterThan(idxImplementStarted);
  });

  it('reduces gate_required → gate_decided through the real WS link', async () => {
    const fix = seed([
      makeStage('design'),
      makeStage('plan', { gate: true }),
      makeStage('implement'),
    ]);

    server = await startServer({
      port: 0,
      dbPath: ':memory:',
      bus: fix.bus,
    });

    let state = emptyState(['design', 'plan', 'implement']);
    const onEvent = (ev: DashboardPipelineEvent): void => {
      state = reduceEvent(state, ev, Date.now());
    };

    client = connectWs({
      baseUrl: server.url.replace(/^http/, 'ws'),
      filter: '*',
      onEvent,
      WebSocketImpl: wsImpl,
      reconnectInitialDelayMs: 25,
      maxReconnectAttempts: 5,
    });
    await client.ready;

    const runPromise = runRequirement(
      makeRunnerDeps(
        fix,
        new Map([
          ['design', happyPathScript],
          ['plan', happyPathScript],
          ['implement', happyPathScript],
        ]),
      ),
      fix.requirementId,
    );

    // Wait until the reducer has observed `gate_required` for the gated stage.
    await waitFor(
      () => state,
      (s) => s.liveStatus === 'awaiting_gate' && s.currentStage === 'plan',
    );

    // Approve via DB. The gates HTTP route does this in production; the
    // runner's `waitForGateDecision` races a bus subscription against a
    // DB poll loop so a DB write alone is enough to unblock it.
    const run = pipeline_runs.getRunByRequirement(fix.db, fix.requirementId)!;
    const planRow = fix.db
      .select()
      .from(stageExecutionsTable)
      .all()
      .find((s) => s.run_id === run.id && s.stage_name === 'plan');
    expect(planRow).toBeDefined();
    gate_decisions.recordDecision(fix.db, {
      stage_execution_id: planRow!.id,
      decided_by: 'tester',
      decision: 'approved',
      feedback: null,
    });

    const result = await runPromise;
    expect(result.status).toBe('completed');

    const finalState = await waitFor(
      () => state,
      (s) => s.liveStatus === 'done',
    );

    // Reducer transitions on gate_decided(approved):
    //   stages[plan].status -> 'gate_approved' (set by reducer's gate_decided
    //   case BEFORE stage_completed arrives), then stage_completed flips it
    //   back to 'succeeded'. Whichever wire-order arrives last wins for the
    //   stage row, but `liveStatus` MUST end at 'done' and the log MUST
    //   contain both gate_required and gate_decided lines.
    const lines = finalState.log.map((e) => e.line);
    expect(lines.some((l) => l === 'gate required: plan')).toBe(true);
    expect(lines.some((l) => l === 'gate decided: plan → approved')).toBe(true);
    expect(lines.some((l) => l === 'run completed')).toBe(true);

    // After approval, the implement stage actually ran.
    const implementStage = finalState.stages.find(
      (s) => s.stage_name === 'implement',
    );
    expect(implementStage?.status).toBe('succeeded');
  });

  it('reconnects after a server-side socket terminate and continues delivering events to the reducer', async () => {
    const fix = seed([makeStage('design')]);

    server = await startServer({
      port: 0,
      dbPath: ':memory:',
      bus: fix.bus,
    });

    let state = emptyState(['design']);
    const closeCodes: number[] = [];
    const onEvent = (ev: DashboardPipelineEvent): void => {
      state = reduceEvent(state, ev, Date.now());
    };
    const onClose = (code: number): void => {
      closeCodes.push(code);
    };

    client = connectWs({
      baseUrl: server.url.replace(/^http/, 'ws'),
      filter: '*',
      onEvent,
      onClose,
      WebSocketImpl: wsImpl,
      reconnectInitialDelayMs: 20,
      maxReconnectAttempts: 5,
    });
    await client.ready;

    // Publish a first event the client should observe.
    fix.bus.publish({
      topic: 'run:r1',
      event: {
        kind: 'run_started',
        run_id: 'r1',
        requirement_id: fix.requirementId,
        at: new Date().toISOString(),
      },
      emitted_at: new Date().toISOString(),
    });
    await waitFor(
      () => state,
      (s) => s.liveStatus === 'running',
    );

    // Force-close every server-side client socket. The dashboard's ws.ts
    // exponential-backoff path should kick in (close code != 1000 and !=
    // 4401), open a new socket, and re-send the subscribe frame.
    for (const c of server.wss.clients) {
      // `terminate()` sends RST and surfaces close code 1006 to the client —
      // distinct from a clean close (1000) and from auth-reject (4401).
      c.terminate();
    }

    // Wait for the close to propagate to the dashboard client.
    await waitFor(
      () => state,
      () => closeCodes.length > 0,
    );

    // After reconnect, the new server-side WS will not have backfilled the
    // old `run_started`. Publish another event; if the client successfully
    // re-subscribed we should see the reducer apply it.
    //
    // We spin-publish in case the reconnect attempt is still racing the
    // server-side subscribe handshake — first publish may be dropped, later
    // ones land once `attachBusBridge` is wired.
    let received = false;
    const stopAt = Date.now() + 3000;
    while (!received && Date.now() < stopAt) {
      fix.bus.publish({
        topic: 'run:r1',
        event: {
          kind: 'stage_started',
          run_id: 'r1',
          stage_name: 'design',
          at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      });
      // Give the loop a chance to flush the message off the socket.
      await new Promise((r) => setTimeout(r, 50));
      received = state.currentStage === 'design';
    }
    expect(received).toBe(true);
    expect(state.stages.find((s) => s.stage_name === 'design')?.status).toBe(
      'running',
    );

    // The reconnect path actually fired (we observed at least one close).
    expect(closeCodes.length).toBeGreaterThan(0);
  });
});
