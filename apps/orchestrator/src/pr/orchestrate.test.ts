import { describe, expect, it } from 'vitest';

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
        // gh pr edit: same order.
        {
          match: ['gh', 'pr', 'edit', '10', '--repo', 'owner/frontend'],
          respond: () => ok(),
        },
        {
          match: ['gh', 'pr', 'edit', '20', '--repo', 'owner/backend'],
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
      (c) => c.argv[0] === 'gh' && c.argv[2] === 'edit',
    );
    expect(editCalls).toHaveLength(2);
    // Phase 2: bodies have real URLs and no more placeholders.
    for (const c of editCalls) {
      const bodyIdx = c.argv.indexOf('--body');
      const body = c.argv[bodyIdx + 1] ?? '';
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
          match: ['gh', 'pr', 'edit', '55', '--repo', 'owner/backend'],
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
