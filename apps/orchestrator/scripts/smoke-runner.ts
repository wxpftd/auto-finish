/**
 * End-to-end smoke for the Pipeline Runner.
 *
 * What it does:
 *   1. mktemp + `git init` a tiny "remote" repo with a README.md
 *   2. Spin up an in-memory SQLite, run migrations
 *   3. Insert Project, Repo, Pipeline, Requirement (1 stage, no gate, no PRs)
 *   4. Call `runRequirement` with:
 *        - LocalSandboxProvider (host process; no real isolation)
 *        - no-op cred injection (Claude CLI inherits host auth)
 *        - real cloneRepos via file:// URL
 *        - no-op PR opener (skip GitHub for this round)
 *   5. Print stage events and final artifact diff
 *
 * Cost: every stage spawns a real `claude -p` subprocess. With Claude Pro/Max
 * subscription this is rate-limited but not metered.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
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
} from '../src/db/index.js';
import { schema } from '../src/db/index.js';
import { EventBus } from '../src/eventbus/index.js';
import { runRequirement } from '../src/runner/index.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';
import { LocalSandboxProvider } from './local-provider.js';
import { requireClaude, requireGit } from './_guards.js';

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
  const root = await mkdtemp(join(tmpdir(), 'auto-finish-remote-'));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'README.md'),
    '# Demo Repo\n\nThis is the smoke-test fixture.\n',
  );
  await runCmd('git', ['init', '-b', 'main'], root);
  await runCmd('git', ['config', 'user.email', 'smoke@local'], root);
  await runCmd('git', ['config', 'user.name', 'Smoke Tester'], root);
  await runCmd('git', ['add', '-A'], root);
  await runCmd('git', ['commit', '-m', 'initial'], root);
  return root;
}

function buildSimplePipeline(): Pipeline {
  return {
    id: 'smoke-pipeline',
    name: 'Smoke Pipeline',
    version: '1.0.0',
    stages: [
      {
        name: 'implement',
        agent_config: {
          system_prompt:
            'You are a software engineer. Your cwd is the project workspace; ' +
            'the only repo is at `myrepo/`. Read `myrepo/README.md` and append a ' +
            'short "## Quick Start" section at the bottom (two lines is enough). ' +
            'Use the Edit tool with the relative path `myrepo/README.md`. Do not ' +
            'commit; do not run git. Reply briefly when done.',
          allowed_tools: ['Read', 'Edit', 'Glob', 'Grep'],
          add_dirs: ['/workspace'],
          max_turns: 10,
        },
        artifacts: [],
        on_failure: 'abort',
      },
    ],
  } as Pipeline;
}

async function main(): Promise<void> {
  requireGit();
  requireClaude();
  console.log('[smoke] setting up remote git repo…');
  const remoteUrl = await setupRemoteRepo();
  console.log(`[smoke] remote at ${remoteUrl}`);

  console.log('[smoke] opening in-memory DB + migrating…');
  const handle = createDb(':memory:');
  runMigrations(handle.db);
  const db = handle.db;

  const project = projects.createProject(db, {
    name: 'smoke',
    description: 'smoke test',
    default_pipeline_id: null,
    sandbox_config_json: {},
    claude_config_json: { credentials_source: 'host_mount' },
  });

  const repo = repos.addRepo(db, {
    project_id: project.id,
    name: 'myrepo',
    git_url: remoteUrl,
    default_branch: 'main',
    working_dir: '/workspace/myrepo',
    test_command: null,
    pr_template: null,
  });

  const pipeline = pipelines.createPipeline(db, {
    name: 'Smoke',
    version: '1.0.0',
    definition_json: buildSimplePipeline(),
  });

  const req = requirements.createRequirement(db, {
    project_id: project.id,
    pipeline_id: pipeline.id,
    title: 'add Quick Start to README',
    description:
      'The README is missing a "Quick Start" section. Add a short one (~2 lines).',
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

  console.log('[smoke] starting runRequirement…');
  const start = Date.now();
  const result = await runRequirement(
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
  const ms = Date.now() - start;

  console.log(`\n[smoke] result: ${JSON.stringify(result)} (${ms}ms)\n`);

  // Dump stage events for forensics, especially on failure.
  const stages = db.select().from(schema.stage_executions).all();
  for (const s of stages) {
    console.log(`\n--- stage ${s.stage_name} (${s.status}) ---`);
    for (const ev of s.events_json) {
      const summary = JSON.stringify(ev).slice(0, 600);
      console.log(`  ${summary}`);
    }
  }
  void stage_executions;

  if (sandboxRoot) {
    const readmePath = join(sandboxRoot, 'workspace/myrepo/README.md');
    try {
      const content = await readFile(readmePath, 'utf8');
      console.log('--- README.md (post-run) ---');
      console.log(content);
      console.log('-----------------------------');
    } catch (err) {
      console.warn(
        `[smoke] could not read post-run README: ${(err as Error).message}`,
      );
    }

    const artifactsDir = join(sandboxRoot, 'workspace/.auto-finish');
    try {
      const entries = await readdir(artifactsDir);
      console.log(`[smoke] .auto-finish/ contains: ${entries.join(', ')}`);
    } catch {
      console.log('[smoke] no .auto-finish/ dir produced');
    }

    console.log(`[smoke] sandbox preserved at: ${sandboxRoot}`);
    console.log('[smoke] (delete it manually when done inspecting)');
  }

  await rm(remoteUrl, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err);
  process.exitCode = 1;
});
