import { describe, expect, it } from 'vitest';

import type { RepoSpec } from '../multi-repo/index.js';
import { commitAndPush, PushError } from './commit-and-push.js';
import { fail, FakeSession, ok } from './__test-utils__/fake-session.js';

const REPO: RepoSpec = {
  id: 'r-fe',
  name: 'frontend',
  git_url: 'https://github.com/owner/frontend.git',
  default_branch: 'main',
  working_dir: '/workspace/frontend',
};

describe('commitAndPush', () => {
  it('happy path: stages, commits, pushes, returns head sha', async () => {
    const session = new FakeSession({
      scripts: [
        { match: ['git', '-C', REPO.working_dir, 'add', '-A'], respond: () => ok() },
        {
          match: ['git', '-C', REPO.working_dir, 'diff', '--cached', '--quiet'],
          // Staged changes present → exit 1.
          respond: () => fail(1),
        },
        {
          match: ['git', '-C', REPO.working_dir, 'commit', '-m'],
          respond: () => ok('[branch abc] msg'),
        },
        {
          match: [
            'git',
            '-C',
            REPO.working_dir,
            'push',
            '-u',
            'origin',
            'auto-finish/req-1',
          ],
          respond: () => ok(),
        },
        {
          match: ['git', '-C', REPO.working_dir, 'rev-parse', 'HEAD'],
          respond: () => ok('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n'),
        },
      ],
    });

    const result = await commitAndPush({
      session,
      repo: REPO,
      branchName: 'auto-finish/req-1',
      commitMessage: 'auto-finish: add health endpoint\n\nrequirement: req-1',
    });

    expect(result).toEqual({
      pushed: true,
      head_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    // Commit message went through as a SINGLE argv element with literal newline.
    const commitCall = session.runCalls.find(
      (c) => c.argv[3] === 'commit',
    );
    expect(commitCall).toBeDefined();
    expect(commitCall?.argv[5]).toBe(
      'auto-finish: add health endpoint\n\nrequirement: req-1',
    );
  });

  it('returns pushed=false when nothing is staged (no commit, no push)', async () => {
    const session = new FakeSession({
      scripts: [
        { match: ['git', '-C', REPO.working_dir, 'add', '-A'], respond: () => ok() },
        {
          match: ['git', '-C', REPO.working_dir, 'diff', '--cached', '--quiet'],
          // Clean index → exit 0.
          respond: () => ok(),
        },
      ],
    });

    const result = await commitAndPush({
      session,
      repo: REPO,
      branchName: 'auto-finish/req-1',
      commitMessage: 'noop',
    });

    expect(result).toEqual({ pushed: false, head_sha: '' });
    // Confirm we stopped: only `add` and `diff --cached --quiet` were invoked.
    expect(session.runCalls.map((c) => c.argv[3])).toEqual([
      'add',
      'diff',
    ]);
  });

  it('throws PushError when git push fails', async () => {
    const session = new FakeSession({
      scripts: [
        { match: ['git', '-C', REPO.working_dir, 'add', '-A'], respond: () => ok() },
        {
          match: ['git', '-C', REPO.working_dir, 'diff', '--cached', '--quiet'],
          respond: () => fail(1),
        },
        {
          match: ['git', '-C', REPO.working_dir, 'commit', '-m'],
          respond: () => ok(),
        },
        {
          match: [
            'git',
            '-C',
            REPO.working_dir,
            'push',
            '-u',
            'origin',
            'auto-finish/req-1',
          ],
          respond: () => fail(128, 'fatal: remote rejected\n'),
        },
      ],
    });

    await expect(
      commitAndPush({
        session,
        repo: REPO,
        branchName: 'auto-finish/req-1',
        commitMessage: 'msg',
      }),
    ).rejects.toBeInstanceOf(PushError);
  });
});
