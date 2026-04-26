/**
 * End-to-end smoke for the Pipeline Runner's GATE-blocking flow.
 *
 * Runs two scenarios sequentially with fresh state each time:
 *   A) gate approved   → run completes and apply stage modifies README
 *   B) gate rejected   → run lands in awaiting_changes; apply does NOT execute
 *
 * Each scenario uses:
 *   - tmp git "remote" with README only (file:// URL)
 *   - in-memory SQLite + migrations
 *   - LocalSandboxProvider with preserveOnDestroy=true
 *   - real bootstrapEnv (clones via file://) and detectChanges
 *   - injectCredentials no-op (Claude CLI inherits host auth)
 *   - openPrs returning [] (skip GitHub side-effects)
 *   - gatePollIntervalMs: 200 (faster than the 1s default)
 *
 * Timing instrumentation:
 *   - t_run_start             : just before runRequirement promise begins
 *   - t_gate_required_seen    : when the bus subscriber sees `gate_required`
 *   - t_decision_recorded     : right after gate_decisions.recordDecision returns
 *   - t_gate_decided_seen     : when the bus subscriber sees `gate_decided`
 *   - t_run_done              : awaited runRequirement promise resolved
 *
 * Polling latency = t_gate_decided_seen - t_decision_recorded. With
 * gatePollIntervalMs=200 it should normally be ≤ 200ms.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  createDb,
  runMigrations,
  projects,
  repos,
  pipelines,
  requirements,
  stage_executions,
  gate_decisions,
} from '../src/db/index.js';
import { schema } from '../src/db/index.js';
import { EventBus } from '../src/eventbus/index.js';
import type { BusMessage } from '../src/eventbus/index.js';
import { runRequirement } from '../src/runner/index.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';
import { LocalSandboxProvider } from './local-provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCmd(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exit_code: code ?? -1, stdout, stderr });
    });
  });
}

async function setupRemoteRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'auto-finish-gate-remote-'));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'README.md'),
    '# Demo Repo\n\nThis is the gate smoke-test fixture.\n',
  );
  await runCmd('git', ['init', '-b', 'main'], root);
  await runCmd('git', ['config', 'user.email', 'smoke@local'], root);
  await runCmd('git', ['config', 'user.name', 'Smoke Tester'], root);
  await runCmd('git', ['add', '-A'], root);
  await runCmd('git', ['commit', '-m', 'initial'], root);
  return root;
}

function buildGatedPipeline(): Pipeline {
  return {
    id: 'smoke-gate-pipeline',
    name: 'Smoke Gate Pipeline',
    version: '1.0.0',
    stages: [
      {
        name: 'propose',
        agent_config: {
          system_prompt:
            'You are a software engineer. Your cwd is the project workspace; ' +
            "the only repo is at `myrepo/`. Read myrepo/README.md, then write " +
            "a one-line proposal to .auto-finish/artifacts/propose/idea.md " +
            "(it'll be reviewed). Use Write to create the file (parent dirs " +
            'will be auto-created). Reply briefly when done.',
          allowed_tools: ['Read', 'Write', 'Edit'],
          add_dirs: ['/workspace'],
          max_turns: 6,
        },
        artifacts: [],
        gate: {
          required: true,
          review_targets: ['.auto-finish/artifacts/propose/idea.md'],
        },
        on_failure: 'abort',
      },
      {
        name: 'apply',
        agent_config: {
          system_prompt:
            'You are a software engineer. Your cwd is the project workspace; ' +
            'the only repo is at `myrepo/`. Read .auto-finish/artifacts/propose/idea.md ' +
            "and append the line `idea applied: <idea-text>` to myrepo/README.md " +
            '(replace <idea-text> with the actual one-line idea). Use Edit to ' +
            'modify myrepo/README.md. Do not commit; do not run git. Reply ' +
            'briefly when done.',
          allowed_tools: ['Read', 'Edit'],
          add_dirs: ['/workspace'],
          max_turns: 6,
        },
        artifacts: [],
        on_failure: 'abort',
      },
    ],
  } as Pipeline;
}

interface CapturedRun {
  events: BusMessage[];
  t_run_start: number;
  t_gate_required_seen: number | null;
  t_decision_recorded: number | null;
  t_gate_decided_seen: number | null;
  t_run_done: number | null;
  sandboxRoot: string;
  result: unknown;
}

function sumStageCosts(db: ReturnType<typeof createDb>['db']): number {
  let total = 0;
  const rows = db.select().from(schema.stage_executions).all();
  for (const r of rows) {
    for (const ev of r.events_json) {
      if ((ev as { type?: string }).type === 'finished') {
        const cost = (ev as { total_cost_usd?: number }).total_cost_usd;
        if (typeof cost === 'number') total += cost;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Scenario runner — shared between A and B; only the decision differs.
// ---------------------------------------------------------------------------

async function runScenario(args: {
  label: string;
  decision: 'approved' | 'rejected';
  feedback: string | null;
}): Promise<CapturedRun> {
  const { label, decision, feedback } = args;
  console.log(`\n========== Scenario ${label} (decision=${decision}) ==========`);

  const remoteUrl = await setupRemoteRepo();
  console.log(`[${label}] remote at ${remoteUrl}`);

  const handle = createDb(':memory:');
  runMigrations(handle.db);
  const db = handle.db;

  const project = projects.createProject(db, {
    name: `smoke-gate-${label}`,
    description: 'gate smoke test',
    default_pipeline_id: null,
    sandbox_config_json: {},
    claude_config_json: { credentials_source: 'host_mount' },
  });

  repos.addRepo(db, {
    project_id: project.id,
    name: 'myrepo',
    git_url: remoteUrl,
    default_branch: 'main',
    working_dir: '/workspace/myrepo',
    test_command: null,
    pr_template: null,
  });

  const pipeline = pipelines.createPipeline(db, {
    name: `Smoke Gate ${label}`,
    version: '1.0.0',
    definition_json: buildGatedPipeline(),
  });

  const req = requirements.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: 'gate smoke test',
    description:
      'Iterate on a small README change with a human review gate in the middle.',
    source: 'manual',
    source_ref: null,
    status: 'queued',
    current_stage_id: null,
  });

  const bus = new EventBus();
  const captured: CapturedRun = {
    events: [],
    t_run_start: 0,
    t_gate_required_seen: null,
    t_decision_recorded: null,
    t_gate_decided_seen: null,
    t_run_done: null,
    sandboxRoot: '',
    result: null,
  };

  // Subscribe FIRST — before we start the run promise — so we don't race the
  // first events out of the runner.
  bus.subscribe('*', (msg) => {
    captured.events.push(msg);
    const k = msg.event.kind;
    console.log(`[${label}][bus] ${k}`, JSON.stringify(msg.event));
    if (k === 'gate_required' && captured.t_gate_required_seen === null) {
      captured.t_gate_required_seen = Date.now();
    }
    if (k === 'gate_decided' && captured.t_gate_decided_seen === null) {
      captured.t_gate_decided_seen = Date.now();
    }
  });

  // Promise that resolves when gate_required is observed.
  const gateRequired = new Promise<void>((resolve) => {
    const unsub = bus.subscribe('*', (msg) => {
      if (msg.event.kind === 'gate_required') {
        unsub();
        resolve();
      }
    });
  });

  const provider = new LocalSandboxProvider({ preserveOnDestroy: true });

  console.log(`[${label}] starting runRequirement…`);
  captured.t_run_start = Date.now();

  const runPromise = runRequirement(
    {
      db,
      bus,
      makeSandboxProvider: () => provider,
      injectCredentials: async () => {
        /* no-op: claude CLI inherits host auth */
      },
      bootstrapEnv: async (bargs) => {
        const sess = bargs.session as unknown as { root?: string };
        if (typeof sess.root === 'string') captured.sandboxRoot = sess.root;
        const { cloneRepos, writeManifest } = await import(
          '../src/multi-repo/index.js'
        );
        const report = await cloneRepos({
          session: bargs.session,
          repos: bargs.repos,
          branchName: bargs.branchName,
        });
        await writeManifest({
          session: bargs.session,
          requirementId: bargs.requirementId,
          cloneReport: report,
        });
        return report;
      },
      openPrs: async () => [],
      gatePollIntervalMs: 200,
    },
    req.id,
  );

  // Wait for the gate to fire.
  await gateRequired;
  console.log(
    `[${label}] gate_required observed at +${
      captured.t_gate_required_seen! - captured.t_run_start
    }ms`,
  );

  // Verify status = awaiting_gate before we record the decision.
  const reqMid = requirements.getRequirement(db, req.id);
  console.log(`[${label}] requirements.status (pre-decision) = ${reqMid?.status}`);
  if (reqMid?.status !== 'awaiting_gate') {
    console.warn(
      `[${label}] WARN: expected status=awaiting_gate, got ${reqMid?.status}`,
    );
  }

  // Read the idea.md artifact via the captured sandbox root.
  let ideaContent = '<unread>';
  if (captured.sandboxRoot) {
    const ideaPath = join(
      captured.sandboxRoot,
      'workspace/.auto-finish/artifacts/propose/idea.md',
    );
    try {
      ideaContent = await readFile(ideaPath, 'utf8');
      console.log(`[${label}] --- idea.md ---\n${ideaContent}\n----------------`);
    } catch (err) {
      console.warn(
        `[${label}] could not read idea.md at ${ideaPath}: ${
          (err as Error).message
        }`,
      );
    }
  }

  // Find the gated stage_execution (propose) and record the decision.
  const stages = db.select().from(schema.stage_executions).all();
  const gated = stages.find((s) => s.stage_name === 'propose');
  if (!gated) throw new Error(`[${label}] propose stage execution not found`);

  console.log(`[${label}] recording decision=${decision}`);
  captured.t_decision_recorded = Date.now();
  gate_decisions.recordDecision(db, {
    stage_execution_id: gated.id,
    decided_by: 'tester',
    decision,
    feedback,
  });

  // Now wait for the run to terminate.
  const result = await runPromise;
  captured.t_run_done = Date.now();
  captured.result = result;

  console.log(`[${label}] result = ${JSON.stringify(result)}`);
  console.log(
    `[${label}] total wallclock = ${captured.t_run_done - captured.t_run_start}ms`,
  );
  if (
    captured.t_gate_decided_seen !== null &&
    captured.t_decision_recorded !== null
  ) {
    console.log(
      `[${label}] polling latency (decision→gate_decided) = ${
        captured.t_gate_decided_seen - captured.t_decision_recorded
      }ms`,
    );
  }

  // Stage forensics.
  const stagesAfter = db.select().from(schema.stage_executions).all();
  for (const s of stagesAfter) {
    console.log(
      `[${label}] stage ${s.stage_name}: status=${s.status} events=${s.events_json.length}`,
    );
  }

  // Final requirement status.
  const reqFinal = requirements.getRequirement(db, req.id);
  console.log(`[${label}] requirements.status (final) = ${reqFinal?.status}`);

  const cost = sumStageCosts(db);
  console.log(`[${label}] total stage cost (sum total_cost_usd) = $${cost.toFixed(6)}`);

  // README post-run dump (relevant to scenario A).
  if (captured.sandboxRoot) {
    const readmePath = join(captured.sandboxRoot, 'workspace/myrepo/README.md');
    try {
      const content = await readFile(readmePath, 'utf8');
      console.log(`[${label}] --- README.md (post-run) ---\n${content}-----------------------------`);
    } catch (err) {
      console.warn(
        `[${label}] could not read README at ${readmePath}: ${(err as Error).message}`,
      );
    }
  }

  // Scenario B sanity: apply must NOT have an execution row.
  if (decision === 'rejected') {
    const applyExec = stagesAfter.find((s) => s.stage_name === 'apply');
    console.log(
      `[${label}] apply stage_executions row present? ${
        applyExec ? `YES (BUG) status=${applyExec.status}` : 'NO (correct)'
      }`,
    );
  }

  await rm(remoteUrl, { recursive: true, force: true });
  return captured;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const overallStart = Date.now();
  console.log(`[smoke-gate] starting at ${new Date().toISOString()}`);

  const a = await runScenario({
    label: 'A',
    decision: 'approved',
    feedback: null,
  });

  const b = await runScenario({
    label: 'B',
    decision: 'rejected',
    feedback: 'not specific enough, please refine',
  });

  const overallMs = Date.now() - overallStart;

  console.log('\n=================== SUMMARY ===================');
  console.log(
    `Scenario A: wallclock=${
      (a.t_run_done ?? Date.now()) - a.t_run_start
    }ms, result=${JSON.stringify(a.result)}`,
  );
  if (a.t_gate_required_seen !== null) {
    console.log(
      `  gate_required at +${a.t_gate_required_seen - a.t_run_start}ms after run start`,
    );
  }
  if (a.t_decision_recorded !== null && a.t_gate_decided_seen !== null) {
    console.log(
      `  polling latency (decision recorded → gate_decided event) = ${
        a.t_gate_decided_seen - a.t_decision_recorded
      }ms`,
    );
  }

  console.log(
    `Scenario B: wallclock=${
      (b.t_run_done ?? Date.now()) - b.t_run_start
    }ms, result=${JSON.stringify(b.result)}`,
  );
  if (b.t_gate_required_seen !== null) {
    console.log(
      `  gate_required at +${b.t_gate_required_seen - b.t_run_start}ms after run start`,
    );
  }
  if (b.t_decision_recorded !== null && b.t_gate_decided_seen !== null) {
    console.log(
      `  polling latency (decision recorded → gate_decided event) = ${
        b.t_gate_decided_seen - b.t_decision_recorded
      }ms`,
    );
  }

  console.log(`Total wallclock = ${overallMs}ms`);
  console.log('==============================================');

  // We never modify global stage_executions imports; reference to silence the
  // unused-import linter.
  void stage_executions;
}

main().catch((err) => {
  console.error('[smoke-gate] FATAL:', err);
  process.exitCode = 1;
});
