import { describe, expect, it, vi } from 'vitest';

import type { RepoDiff, RepoSpec } from '../multi-repo/index.js';
import { publishPullRequests } from './orchestrate.js';
import { fail, FakeSession, ok, type RunScript } from './__test-utils__/fake-session.js';

const FRONTEND: RepoSpec = {
  id: 'r-fe',
  name: 'frontend',
  git_url: 'https://github.com/owner/frontend.git',
  default_branch: 'main',
  working_dir: '/workspace/frontend',
};

const BACKEND: RepoSpec = {
  id: 'r-be',
  name: 'backend',
  git_url: 'https://github.com/owner/backend.git',
  default_branch: 'main',
  working_dir: '/workspace/backend',
};

function diff(spec: RepoSpec, hasChanges: boolean): RepoDiff {
  return {
    repo_id: spec.id,
    working_dir: spec.working_dir,
    has_changes: hasChanges,
    files_changed: hasChanges ? 1 : 0,
    insertions: hasChanges ? 5 : 0,
    deletions: hasChanges ? 0 : 0,
    changed_files: hasChanges ? ['src/x.ts'] : [],
  };
}

/** All five git steps that commitAndPush makes for one repo. */
function pushScripts(repo: RepoSpec, branch: string, sha: string): RunScript[] {
  return [
    { match: ['git', '-C', repo.working_dir, 'add', '-A'], respond: () => ok() },
    {
      match: ['git', '-C', repo.working_dir, 'diff', '--cached', '--quiet'],
      respond: () => fail(1),
    },
    {
      match: ['git', '-C', repo.working_dir, 'commit', '-m'],
      respond: () => ok(),
    },
    {
      match: ['git', '-C', repo.working_dir, 'push', '-u', 'origin', branch],
      respond: () => ok(),
    },
    {
      match: ['git', '-C', repo.working_dir, 'rev-parse', 'HEAD'],
      respond: () => ok(`${sha}\n`),
    },
  ];
}

describe('publishPullRequests', () => {
  it('two changed repos: pushes both, opens 2 PRs, edits both with sibling URLs', async () => {
    const branch = 'auto-finish/req-1';
    const session = new FakeSession({
      scripts: [
        ...pushScripts(FRONTEND, branch, 'aaa'),
        ...pushScripts(BACKEND, branch, 'bbb'),
        // gh pr create: frontend first, backend second (sequential per spec).
        {
          match: [
            'gh',
            'pr',
            'create',
            '--repo',
            'owner/frontend',
            '--base',
            'main',
            '--head',
            branch,
          ],
          respond: () => ok('https://github.com/owner/frontend/pull/10\n'),
        },
        {
          match: [
            'gh',
            'pr',
            'create',
            '--repo',
            'owner/backend',
            '--base',
            'main',
            '--head',
            branch,
          ],
          respond: () => ok('https://github.com/owner/backend/pull/20\n'),
        },
        // gh api PATCH (REST, replaces gh pr edit — see gh-pr.ts header).
        {
          match: ['gh', 'api', '-X', 'PATCH', '/repos/owner/frontend/pulls/10'],
          respond: () => ok(),
        },
        {
          match: ['gh', 'api', '-X', 'PATCH', '/repos/owner/backend/pulls/20'],
          respond: () => ok(),
        },
      ],
    });

    const result = await publishPullRequests({
      session,
      requirementId: 'req-1',
      requirementTitle: 'Add /health endpoint',
      requirementDescription: 'Backend exposes /health; frontend reads it.',
      perRepo: [
        { repo: FRONTEND, diff: diff(FRONTEND, true) },
        { repo: BACKEND, diff: diff(BACKEND, true) },
      ],
      baseBranch: (r) => r.default_branch,
      branchName: branch,
    });

    expect(result).toEqual([
      {
        repo_id: 'r-fe',
        pr_url: 'https://github.com/owner/frontend/pull/10',
        pr_number: 10,
      },
      {
        repo_id: 'r-be',
        pr_url: 'https://github.com/owner/backend/pull/20',
        pr_number: 20,
      },
    ]);

    // Inspect Phase 1 vs Phase 2 bodies via captured argv.
    const createCalls = session.runCalls.filter(
      (c) => c.argv[0] === 'gh' && c.argv[2] === 'create',
    );
    expect(createCalls).toHaveLength(2);
    // Phase 1: every body lists both repos (by NAME) as `pending`.
    for (const c of createCalls) {
      const bodyIdx = c.argv.indexOf('--body');
      const body = c.argv[bodyIdx + 1] ?? '';
      expect(body).toContain('- frontend: pending');
      expect(body).toContain('- backend: pending');
    }

    const editCalls = session.runCalls.filter(
      (c) => c.argv[0] === 'gh' && c.argv[1] === 'api',
    );
    expect(editCalls).toHaveLength(2);
    // Phase 2: bodies have real URLs and no more placeholders. `gh api` carries
    // the body as a single `body=<full body>` argv element via `-f`.
    for (const c of editCalls) {
      const bodyArg = c.argv.find((a) => a.startsWith('body=')) ?? '';
      const body = bodyArg.slice('body='.length);
      expect(body).toContain(
        '- frontend: https://github.com/owner/frontend/pull/10',
      );
      expect(body).toContain(
        '- backend: https://github.com/owner/backend/pull/20',
      );
      expect(body).not.toContain('pending');
    }
  });

  it('skips repos with has_changes=false (silently)', async () => {
    const branch = 'auto-finish/req-2';
    const session = new FakeSession({
      // Only the BACKEND has changes — the frontend should never be touched.
      scripts: [
        ...pushScripts(BACKEND, branch, 'b1'),
        {
          match: ['gh', 'pr', 'create', '--repo', 'owner/backend'],
          respond: () => ok('https://github.com/owner/backend/pull/55\n'),
        },
        {
          match: ['gh', 'api', '-X', 'PATCH', '/repos/owner/backend/pulls/55'],
          respond: () => ok(),
        },
      ],
    });

    const result = await publishPullRequests({
      session,
      requirementId: 'req-2',
      requirementTitle: 'Backend-only change',
      requirementDescription: 'Adds telemetry.',
      perRepo: [
        { repo: FRONTEND, diff: diff(FRONTEND, false) },
        { repo: BACKEND, diff: diff(BACKEND, true) },
      ],
      baseBranch: (r) => r.default_branch,
      branchName: branch,
    });

    expect(result).toEqual([
      {
        repo_id: 'r-be',
        pr_url: 'https://github.com/owner/backend/pull/55',
        pr_number: 55,
      },
    ]);

    // No git/gh call should reference /workspace/frontend.
    for (const c of session.runCalls) {
      expect(c.argv).not.toContain('/workspace/frontend');
      expect(c.argv).not.toContain('owner/frontend');
    }

    // Single-repo run → cross-link section MUST be omitted.
    const createCall = session.runCalls.find(
      (c) => c.argv[0] === 'gh' && c.argv[2] === 'create',
    );
    const bodyIdx = createCall?.argv.indexOf('--body') ?? -1;
    const body = createCall?.argv[bodyIdx + 1] ?? '';
    expect(body).not.toContain('Related PRs');
    expect(body).not.toContain('pending');
  });

  it('phase-2 cross-link edit failure does NOT discard already-opened PRs', async () => {
    // Hardening for the case where the cross-link PATCH fails after PRs have
    // already been pushed and opened on GitHub. Throwing here would force the
    // runner's outer catch to mark the run failed AND skip persisting the
    // pull_requests rows — losing track of PRs that genuinely landed.
    const branch = 'auto-finish/req-4';
    const session = new FakeSession({
      scripts: [
        ...pushScripts(BACKEND, branch, 'b1'),
        {
          match: ['gh', 'pr', 'create', '--repo', 'owner/backend'],
          respond: () => ok('https://github.com/owner/backend/pull/77\n'),
        },
        {
          match: ['gh', 'api', '-X', 'PATCH', '/repos/owner/backend/pulls/77'],
          respond: () => fail(1, '', 'simulated GitHub API hiccup'),
        },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await publishPullRequests({
        session,
        requirementId: 'req-4',
        requirementTitle: 'Edge case',
        requirementDescription: '',
        perRepo: [{ repo: BACKEND, diff: diff(BACKEND, true) }],
        baseBranch: (r) => r.default_branch,
        branchName: branch,
      });

      // The PR is open and the array reflects that — runner can persist it.
      expect(result).toEqual([
        {
          repo_id: 'r-be',
          pr_url: 'https://github.com/owner/backend/pull/77',
          pr_number: 77,
        },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('phase-2 cross-link edit failed for PR #77'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns empty array when no repo has changes', async () => {
    const session = new FakeSession({ scripts: [] });
    const result = await publishPullRequests({
      session,
      requirementId: 'req-3',
      requirementTitle: 'Nothing to do',
      requirementDescription: '',
      perRepo: [
        { repo: FRONTEND, diff: diff(FRONTEND, false) },
        { repo: BACKEND, diff: diff(BACKEND, false) },
      ],
      baseBranch: (r) => r.default_branch,
      branchName: 'auto-finish/req-3',
    });

    expect(result).toEqual([]);
    expect(session.runCalls).toHaveLength(0);
  });
});
