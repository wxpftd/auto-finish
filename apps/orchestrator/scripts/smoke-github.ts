/**
 * End-to-end smoke for the Pipeline Runner against a REAL GitHub repo.
 *
 * Validates: cloneRepos (SSH) → claude Edit → commitAndPush → gh pr create →
 * Phase-2 cross-link edit, then cleans up the PR + remote branch.
 *
 * Pre-requisites assumed already configured on the host:
 *   - SSH key registered with GitHub (push works to wxpftd/auto-finish-smoke-2026)
 *   - `gh` CLI authenticated as wxpftd with repo+workflow scopes
 *   - `claude` CLI authenticated (subscription)
 *
 * Usage:
 *   pnpm --filter @auto-finish/orchestrator exec tsx scripts/smoke-github.ts
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {
  createDb,
  runMigrations,
  projects,
  repos,
  pipelines,
  requirements,
} from '../src/db/index.js';
import { schema } from '../src/db/index.js';
import { EventBus } from '../src/eventbus/index.js';
import { runRequirement } from '../src/runner/index.js';
import type { Pipeline } from '@auto-finish/pipeline-schema';
import { LocalSandboxProvider } from './local-provider.js';
import type { RepoDiff, RepoSpec } from '../src/multi-repo/index.js';
import type { SandboxSession } from '../src/sandbox/interface.js';
import {
  requireClaude,
  requireGhAuth,
  requireGit,
  requireGitRemoteAccess,
} from './_guards.js';

const REPO_SSH = 'git@github.com:wxpftd/auto-finish-smoke-2026.git';
const REPO_SLUG = 'wxpftd/auto-finish-smoke-2026';
const REPO_DEFAULT_BRANCH = 'main';

function hostRun(
  cmd: string,
  args: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

function buildPipeline(): Pipeline {
  return {
    id: 'smoke-github-pipeline',
    name: 'Smoke (real GitHub)',
    version: '1.0.0',
    stages: [
      {
        name: 'implement',
        agent_config: {
          system_prompt:
            "Append the line 'smoke timestamp: <ISO date>' followed by your " +
            'current ISO timestamp to myrepo/README.md. Use the Edit tool ' +
            'with relative path `myrepo/README.md`. Reply briefly.',
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

/**
 * Override of detectChanges that compares the working tree against the base
 * branch (no `...` triple-dot range). Required because Claude's `Edit` tool
 * produces uncommitted working-tree changes; the real detectChanges uses
 * `<base>...<branch>` which only sees committed changes — at this point the
 * branch is still at the base commit, so it returns has_changes=false and
 * publishPullRequests would skip the repo entirely.
 */
async function detectWorkingTreeChanges(args: {
  session: SandboxSession;
  repos: RepoSpec[];
  baseBranch: string;
  workingBranch: string;
}): Promise<RepoDiff[]> {
  const { session, repos: repoList, baseBranch } = args;
  return Promise.all(
    repoList.map(async (repo): Promise<RepoDiff> => {
      const empty: RepoDiff = {
        repo_id: repo.id,
        working_dir: repo.working_dir,
        has_changes: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        changed_files: [],
      };
      const shortstat = await session.run([
        'git',
        '-C',
        repo.working_dir,
        'diff',
        '--shortstat',
        baseBranch,
      ]);
      const nameOnly = await session.run([
        'git',
        '-C',
        repo.working_dir,
        'diff',
        '--name-only',
        baseBranch,
      ]);
      if (shortstat.exit_code !== 0 || nameOnly.exit_code !== 0) {
        return empty;
      }
      const filesMatch = shortstat.stdout.match(/(\d+)\s+files?\s+changed/);
      const insMatch = shortstat.stdout.match(/(\d+)\s+insertions?\(\+\)/);
      const delMatch = shortstat.stdout.match(/(\d+)\s+deletions?\(-\)/);
      const changed_files = nameOnly.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const files_changed = filesMatch?.[1] ? parseInt(filesMatch[1], 10) : 0;
      const insertions = insMatch?.[1] ? parseInt(insMatch[1], 10) : 0;
      const deletions = delMatch?.[1] ? parseInt(delMatch[1], 10) : 0;
      return {
        repo_id: repo.id,
        working_dir: repo.working_dir,
        has_changes:
          files_changed > 0 ||
          insertions > 0 ||
          deletions > 0 ||
          changed_files.length > 0,
        files_changed,
        insertions,
        deletions,
        changed_files,
      };
    }),
  );
}

async function cleanup(prNumber: number | null, branchName: string): Promise<void> {
  console.log('\n[cleanup] starting…');
  if (prNumber !== null) {
    const closeRes = await hostRun('gh', [
      'pr',
      'close',
      String(prNumber),
      '--repo',
      REPO_SLUG,
      '--delete-branch',
    ]);
    if (closeRes.exit_code === 0) {
      console.log(`[cleanup] gh pr close #${prNumber} --delete-branch: OK`);
    } else {
      console.warn(
        `[cleanup] gh pr close failed (exit ${closeRes.exit_code}): ${closeRes.stderr}`,
      );
    }
  }
  // Belt-and-braces: try to delete remote branch even if PR close didn't
  // (or no PR was opened).
  const refRes = await hostRun('gh', [
    'api',
    '-X',
    'DELETE',
    `repos/${REPO_SLUG}/git/refs/heads/${branchName}`,
  ]);
  if (refRes.exit_code === 0) {
    console.log(`[cleanup] DELETE refs/heads/${branchName}: OK`);
  } else if (/Reference does not exist/i.test(refRes.stderr)) {
    console.log(`[cleanup] remote branch ${branchName} already gone`);
  } else {
    console.warn(
      `[cleanup] DELETE refs/heads/${branchName} failed (exit ${refRes.exit_code}): ${refRes.stderr}`,
    );
  }
  // Verify branch is gone.
  const branchesRes = await hostRun('gh', [
    'api',
    `repos/${REPO_SLUG}/branches`,
  ]);
  if (branchesRes.exit_code === 0) {
    try {
      const branches = JSON.parse(branchesRes.stdout) as { name: string }[];
      const stillThere = branches.some((b) => b.name === branchName);
      if (stillThere) {
        console.warn(
          `[cleanup] WARN branch ${branchName} still listed: ${branches
            .map((b) => b.name)
            .join(', ')}`,
        );
      } else {
        console.log(
          `[cleanup] confirmed: branch ${branchName} not in branches list`,
        );
        console.log(
          `[cleanup] branches now: ${branches.map((b) => b.name).join(', ')}`,
        );
      }
    } catch (err) {
      console.warn(
        `[cleanup] could not parse branches JSON: ${(err as Error).message}`,
      );
    }
  }
}

async function main(): Promise<void> {
  requireGit();
  requireClaude();
  requireGhAuth();
  requireGitRemoteAccess(REPO_SSH);
  const wallStart = Date.now();
  // Unique branch name with timestamp + random hex.
  const branchName = `auto-finish/smoke-${Date.now()}-${randomBytes(3).toString('hex')}`;
  console.log(`[smoke] target branch: ${branchName}`);

  let prNumber: number | null = null;

  try {
    console.log('[smoke] opening in-memory DB + migrating…');
    const handle = createDb(':memory:');
    runMigrations(handle.db);
    const db = handle.db;

    const project = projects.createProject(db, {
      name: 'smoke-github',
      description: 'real GitHub smoke',
      default_pipeline_id: null,
      sandbox_config_json: {},
      claude_config_json: { credentials_source: 'host_mount' },
    });

    repos.addRepo(db, {
      project_id: project.id,
      name: 'myrepo',
      git_url: REPO_SSH,
      default_branch: REPO_DEFAULT_BRANCH,
      working_dir: '/workspace/myrepo',
      test_command: null,
      pr_template: null,
    });

    const pipeline = pipelines.createPipeline(db, {
      name: 'Smoke (real GitHub)',
      version: '1.0.0',
      definition_json: buildPipeline(),
    });

    const req = requirements.createRequirement(db, {
      project_id: project.id,
      pipeline_id: pipeline.id,
      title: 'append smoke timestamp to README',
      description:
        "Append the line 'smoke timestamp: <ISO date>' followed by your " +
        'current ISO timestamp to myrepo/README.md. Use the Edit tool with ' +
        'relative path `myrepo/README.md`. Reply briefly.',
      source: 'manual',
      source_ref: null,
      status: 'queued',
      current_stage_id: null,
    });

    const bus = new EventBus();
    bus.subscribe('*', (msg) => {
      // Compact event log so the 5-minute window logs are readable.
      const ev = msg.event as { kind: string };
      console.log(`[bus] ${ev.kind}`);
    });

    const provider = new LocalSandboxProvider({ preserveOnDestroy: true });
    let sandboxRoot = '';

    console.log('[smoke] starting runRequirement…');
    const runStart = Date.now();
    const result = await runRequirement(
      {
        db,
        bus,
        makeSandboxProvider: () => provider,
        // Override branch name to use our unique value.
        branchName: () => branchName,
        // No-op: host has claude credentials, sandbox is the host process.
        injectCredentials: async () => {},
        // Wrap bootstrap to pass gitAuthor so commits are attributed correctly.
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
            gitAuthor: {
              name: 'auto-finish smoke',
              email: 'smoke@auto-finish.local',
            },
          });
          await writeManifest({
            session: args.session,
            requirementId: args.requirementId,
            cloneReport: report,
          });
          return report;
        },
        // Override detectChanges to see uncommitted working-tree edits.
        detectChanges: detectWorkingTreeChanges,
        // Default openPrs == publishPullRequests (real gh pr create + edit).
      },
      req.id,
    );
    const runMs = Date.now() - runStart;
    console.log(`\n[smoke] runRequirement returned in ${runMs}ms`);
    console.log(`[smoke] result: ${JSON.stringify(result, null, 2)}`);

    // ----- Assertions / observations -----
    if (result.status !== 'completed') {
      console.error(`[smoke] FAIL: status was ${result.status}, not completed`);
    } else {
      console.log('[smoke] PASS: status === completed');
    }

    if (result.status === 'completed' && result.prs.length === 1) {
      console.log(`[smoke] PASS: exactly 1 PR opened`);
      const pr = result.prs[0]!;
      prNumber = pr.pr_number;
      console.log(`[smoke] PR URL: ${pr.pr_url}`);

      const expectedPrefix = `https://github.com/${REPO_SLUG}/pull/`;
      if (pr.pr_url.startsWith(expectedPrefix)) {
        console.log(`[smoke] PASS: PR URL targets ${REPO_SLUG}`);
      } else {
        console.error(
          `[smoke] FAIL: PR URL prefix mismatch (got ${pr.pr_url})`,
        );
      }

      // Verify via gh pr view.
      const viewRes = await hostRun('gh', [
        'pr',
        'view',
        String(pr.pr_number),
        '--repo',
        REPO_SLUG,
        '--json',
        'number,url,title,body,headRefName,baseRefName,state',
      ]);
      if (viewRes.exit_code === 0) {
        const view = JSON.parse(viewRes.stdout) as {
          number: number;
          url: string;
          title: string;
          body: string;
          headRefName: string;
          baseRefName: string;
          state: string;
        };
        console.log(`[smoke] PASS: gh pr view #${view.number} succeeded`);
        console.log(`[smoke] PR title: ${view.title}`);
        console.log(`[smoke] PR head -> base: ${view.headRefName} -> ${view.baseRefName}`);
        console.log(`[smoke] PR state: ${view.state}`);
        console.log(`[smoke] --- PR body (Phase-2, post cross-link edit) ---`);
        console.log(view.body);
        console.log(`[smoke] --- end PR body ---`);
        // 1-repo case: cross-link section should be omitted.
        if (/Related PRs/i.test(view.body)) {
          console.log(
            '[smoke] OBSERVATION: cross-link section IS present in body',
          );
        } else {
          console.log(
            '[smoke] OBSERVATION: cross-link section omitted (matches 1-repo design)',
          );
        }
      } else {
        console.error(
          `[smoke] FAIL: gh pr view failed: ${viewRes.stderr}`,
        );
      }

      // Capture diff that landed on the PR.
      const diffRes = await hostRun('gh', [
        'pr',
        'diff',
        String(pr.pr_number),
        '--repo',
        REPO_SLUG,
      ]);
      if (diffRes.exit_code === 0) {
        console.log('[smoke] --- PR diff ---');
        console.log(diffRes.stdout);
        console.log('[smoke] --- end PR diff ---');
      } else {
        console.error(`[smoke] FAIL: gh pr diff failed: ${diffRes.stderr}`);
      }
    } else if (result.status === 'completed') {
      console.error(
        `[smoke] FAIL: expected exactly 1 PR, got ${result.prs.length}`,
      );
    }

    // Dump stage events for forensics.
    const stages = db.select().from(schema.stage_executions).all();
    for (const s of stages) {
      console.log(`\n--- stage ${s.stage_name} (${s.status}) ---`);
      for (const ev of s.events_json) {
        const summary = JSON.stringify(ev).slice(0, 500);
        console.log(`  ${summary}`);
      }
    }

    if (sandboxRoot) {
      const readmePath = join(sandboxRoot, 'workspace/myrepo/README.md');
      try {
        const content = await readFile(readmePath, 'utf8');
        console.log('--- README.md (post-run, in sandbox) ---');
        console.log(content);
        console.log('-----------------------------');
      } catch (err) {
        console.warn(
          `[smoke] could not read post-run README: ${(err as Error).message}`,
        );
      }
      try {
        const entries = await readdir(
          join(sandboxRoot, 'workspace/.auto-finish'),
        );
        console.log(`[smoke] .auto-finish/ contains: ${entries.join(', ')}`);
      } catch {
        /* ignore */
      }
      console.log(`[smoke] sandbox preserved at: ${sandboxRoot}`);
    }
  } catch (err) {
    console.error('[smoke] FATAL during run:', err);
    process.exitCode = 1;
  } finally {
    // Cleanup ALWAYS — even if the run failed partway through, the branch
    // may exist on the remote.
    try {
      await cleanup(prNumber, branchName);
    } catch (err) {
      console.error('[smoke] cleanup raised:', err);
    }
    const wallMs = Date.now() - wallStart;
    console.log(`\n[smoke] wallclock: ${wallMs}ms (${(wallMs / 1000).toFixed(1)}s)`);
  }
}

main().catch((err) => {
  console.error('[smoke] FATAL:', err);
  process.exitCode = 1;
});
