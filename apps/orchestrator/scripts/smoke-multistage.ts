/**
 * 4-stage end-to-end smoke for the Pipeline Runner.
 *
 * Mirrors `smoke-runner.ts` but exercises FOUR stages (analyze → design →
 * implement → verify), no gates, with real `claude -p` subprocesses driven
 * by `LocalSandboxProvider`. Surfaces any bug that 365 unit tests didn't catch.
 *
 * Sandbox is preserved for forensics regardless of outcome.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';

import {
  createDb,
  runMigrations,
  projects,
  repos,
  pipelines,
  requirements,
  schema,
} from '../src/db/index.js';
import { EventBus } from '../src/eventbus/index.js';
import { runRequirement } from '../src/runner/index.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';
import { LocalSandboxProvider } from './local-provider.js';

interface CmdResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

function runCmd(cmd: string, args: string[], cwd?: string): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exit_code: code ?? -1, stdout, stderr });
    });
  });
}

async function setupRemoteRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'auto-finish-multistage-remote-'));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'README.md'),
    '# Multistage Demo Repo\n\n' +
      'A tiny fixture used by the auto-finish 4-stage smoke test. ' +
      'It exists so the orchestrator has something concrete to read, design ' +
      'against, modify, and verify.\n',
  );
  await writeFile(
    join(root, 'app.js'),
    [
      '// Tiny demo app for multistage smoke.',
      '',
      'function main() {',
      '  console.log("hello");',
      '}',
    ].join('\n') + '\n',
  );
  await runCmd('git', ['init', '-b', 'main'], root);
  await runCmd('git', ['config', 'user.email', 'smoke@local'], root);
  await runCmd('git', ['config', 'user.name', 'Smoke Tester'], root);
  await runCmd('git', ['add', '-A'], root);
  await runCmd('git', ['commit', '-m', 'initial'], root);
  return root;
}

function build4StagePipeline(): Pipeline {
  // Per-stage instructions live in `system_prompt`; the runner injects the
  // requirement title + description as the user prompt. RELATIVE paths
  // throughout because LocalSandboxProvider runs claude on the host (cwd =
  // sandbox root); sandbox-internal `/workspace` paths confuse it.
  return {
    id: 'smoke-4stage-pipeline',
    name: 'Smoke 4-Stage',
    version: '1.0.0',
    stages: [
      {
        name: 'analyze',
        agent_config: {
          system_prompt:
            'Stage: analyze. Your cwd is the workspace root. ' +
            'Read myrepo/README.md, then write a one-paragraph summary to ' +
            '.auto-finish/artifacts/analyze/summary.md. ' +
            'Use Edit/Write tools with relative paths. Reply briefly when done.',
          allowed_tools: ['Read', 'Write', 'Edit'],
          add_dirs: ['/workspace'],
          max_turns: 6,
        },
        artifacts: [],
        on_failure: 'pause',
      },
      {
        name: 'design',
        agent_config: {
          system_prompt:
            'Stage: design. Your cwd is the workspace root. ' +
            'Read .auto-finish/artifacts/analyze/summary.md and write a ' +
            '3-bullet design plan to .auto-finish/artifacts/design/plan.md. ' +
            'Use Edit/Write with relative paths. Reply briefly when done.',
          allowed_tools: ['Read', 'Write', 'Edit'],
          add_dirs: ['/workspace'],
          max_turns: 6,
        },
        artifacts: [],
        on_failure: 'pause',
      },
      {
        name: 'implement',
        agent_config: {
          system_prompt:
            'Stage: implement. Your cwd is the workspace root. ' +
            'Append a `// touched by auto-finish` comment line to ' +
            'myrepo/app.js (just append it at the end of the file). ' +
            'Use the Edit tool with the relative path myrepo/app.js. ' +
            'Reply briefly when done.',
          allowed_tools: ['Read', 'Edit'],
          add_dirs: ['/workspace'],
          max_turns: 6,
        },
        artifacts: [],
        on_failure: 'pause',
      },
      {
        name: 'verify',
        agent_config: {
          system_prompt:
            'Stage: verify. Your cwd is the workspace root. ' +
            'Read myrepo/app.js and write a one-line confirmation to ' +
            '.auto-finish/artifacts/verify/report.md indicating whether ' +
            'the `// touched by auto-finish` comment is present. ' +
            'Use Edit/Write with relative paths. Reply briefly when done.',
          allowed_tools: ['Read', 'Write', 'Edit'],
          add_dirs: ['/workspace'],
          max_turns: 6,
        },
        artifacts: [],
        on_failure: 'pause',
      },
    ],
  } as Pipeline;
}

async function listRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      let st;
      try {
        st = await stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(p);
      } else {
        out.push(p);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

async function main(): Promise<void> {
  const overall = Date.now();
  console.log('[smoke4] setting up remote git repo…');
  const remoteUrl = await setupRemoteRepo();
  console.log(`[smoke4] remote at ${remoteUrl}`);

  console.log('[smoke4] opening in-memory DB + migrating…');
  const handle = createDb(':memory:');
  runMigrations(handle.db);
  const db = handle.db;

  const project = projects.createProject(db, {
    name: 'smoke4',
    description: 'multistage smoke test',
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
    name: 'Smoke 4-Stage',
    version: '1.0.0',
    definition_json: build4StagePipeline(),
  });

  const req = requirements.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: 'smoke 4-stage',
    description:
      'End-to-end multistage smoke. Each stage carries its own instructions ' +
      'in its system prompt — follow them precisely.',
    source: 'manual',
    source_ref: null,
    status: 'queued',
    current_stage_id: null,
  });

  const bus = new EventBus();
  bus.subscribe('*', (msg) => {
    console.log(`[bus] ${msg.event.kind}`, JSON.stringify(msg.event));
  });

  const provider = new LocalSandboxProvider({ preserveOnDestroy: true });
  let sandboxRoot = '';

  console.log('[smoke4] starting runRequirement (4 stages)…');
  const start = Date.now();

  let result: Awaited<ReturnType<typeof runRequirement>> | undefined;
  let runError: unknown = undefined;
  try {
    result = await runRequirement(
      {
        db,
        bus,
        makeSandboxProvider: () => provider,
        injectCredentials: async () => {},
        bootstrapEnv: async (args) => {
          const sess = args.session as unknown as { root?: string };
          if (typeof sess.root === 'string') sandboxRoot = sess.root;
          const { cloneRepos, writeManifest } = await import(
            '../src/multi-repo/index.js'
          );
          const report = await cloneRepos({
            session: args.session,
            repos: args.repos,
            branchName: args.branchName,
          });
          await writeManifest({
            session: args.session,
            requirementId: args.requirementId,
            cloneReport: report,
          });
          return report;
        },
        openPrs: async () => [],
      },
      req.id,
    );
  } catch (err) {
    runError = err;
  }
  const ms = Date.now() - start;

  // ---- Forensics regardless of outcome --------------------------------------
  console.log('\n========= FORENSICS =========');
  console.log(
    `[smoke4] result: ${
      runError ? `THROWN(${(runError as Error).message})` : JSON.stringify(result)
    } (${ms}ms run, ${Date.now() - overall}ms wall)`,
  );

  // Stage executions in DB.
  const stages = db.select().from(schema.stage_executions).all();
  console.log(`\n[smoke4] stage_executions in DB: ${stages.length}`);
  let totalCostUsd = 0;
  let totalCostKnown = false;
  for (const s of stages) {
    console.log(
      `\n--- stage "${s.stage_name}" status=${s.status} events=${s.events_json.length} ---`,
    );
    for (const ev of s.events_json) {
      const summary = JSON.stringify(ev).slice(0, 600);
      console.log(`  ${summary}`);
      if (ev.type === 'finished') {
        const c = (ev as { total_cost_usd?: number }).total_cost_usd;
        if (typeof c === 'number') {
          totalCostUsd += c;
          totalCostKnown = true;
        }
      }
    }
  }

  // Final Requirement row.
  const reqAfter = requirements.getRequirement(db, req.id);
  console.log(`\n[smoke4] requirement.status (final) = ${reqAfter?.status}`);
  console.log(
    `[smoke4] requirement.current_stage_id (final) = ${reqAfter?.current_stage_id}`,
  );

  console.log(
    `\n[smoke4] total cost across finished events: ${
      totalCostKnown ? `$${totalCostUsd.toFixed(6)}` : 'unknown (no finished events with cost)'
    }`,
  );

  if (sandboxRoot) {
    const wsRoot = join(sandboxRoot, 'workspace');
    const artifactsDir = join(wsRoot, '.auto-finish', 'artifacts');
    console.log(`\n[smoke4] artifacts dir: ${artifactsDir}`);
    const files = await listRecursive(artifactsDir);
    if (files.length === 0) {
      console.log('  (no artifact files produced)');
    } else {
      for (const f of files) {
        const rel = relative(artifactsDir, f);
        try {
          const buf = await readFile(f, 'utf8');
          console.log(`\n  --- ${rel} (${buf.length} chars) ---`);
          console.log(`  ${buf.slice(0, 200).replace(/\n/g, '\n  ')}`);
        } catch (err) {
          console.log(`  --- ${rel} (read error: ${(err as Error).message}) ---`);
        }
      }
    }

    // Inner repo diff.
    const repoDir = join(wsRoot, 'myrepo');
    console.log(`\n[smoke4] git diff inside ${repoDir}:`);
    try {
      const diff = await runCmd('git', ['-C', repoDir, 'diff'], undefined);
      console.log(`  exit=${diff.exit_code}`);
      console.log(diff.stdout || '(empty diff stdout)');
      if (diff.stderr) console.log(`  stderr: ${diff.stderr}`);
    } catch (err) {
      console.log(`  diff failed: ${(err as Error).message}`);
    }

    // Show the post-run app.js so we can inspect what the implement stage did.
    try {
      const appJs = await readFile(join(repoDir, 'app.js'), 'utf8');
      console.log(`\n[smoke4] post-run myrepo/app.js:\n${appJs}`);
    } catch (err) {
      console.log(`[smoke4] could not read post-run app.js: ${(err as Error).message}`);
    }

    console.log(`\n[smoke4] sandbox preserved at: ${sandboxRoot}`);
    console.log('[smoke4] (delete it manually when done inspecting)');
  } else {
    console.log('[smoke4] sandboxRoot was never captured — bootstrapEnv may not have run');
  }

  // Cleanup remote repo only.
  await rm(remoteUrl, { recursive: true, force: true });
  console.log(`\n[smoke4] removed remote ${remoteUrl}`);

  if (runError) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[smoke4] FATAL:', err);
  process.exitCode = 1;
});
