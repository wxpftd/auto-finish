import { describe, expect, it } from 'vitest';

import type { RepoSpec } from '../multi-repo/index.js';
import {
  editPullRequestBody,
  inferRepoSlug,
  openPullRequest,
  PrCreateError,
  UnknownGitHostError,
} from './gh-pr.js';
import { fail, FakeSession, ok } from './__test-utils__/fake-session.js';

const REPO_HTTPS: RepoSpec = {
  id: 'r-fe',
  name: 'frontend',
  git_url: 'https://github.com/owner/frontend.git',
  default_branch: 'main',
  working_dir: '/workspace/frontend',
};

describe('inferRepoSlug', () => {
  it('parses https URL with .git suffix', () => {
    expect(inferRepoSlug('https://github.com/owner/repo.git')).toBe(
      'owner/repo',
    );
  });

  it('parses https URL without .git suffix', () => {
    expect(inferRepoSlug('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses ssh scp form', () => {
    expect(inferRepoSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(inferRepoSlug('git@github.com:owner/repo')).toBe('owner/repo');
  });

  it('parses ssh:// URL form', () => {
    expect(inferRepoSlug('ssh://git@github.com/owner/repo.git')).toBe(
      'owner/repo',
    );
  });

  it('throws UnknownGitHostError for non-github hosts', () => {
    expect(() => inferRepoSlug('https://gitlab.com/owner/repo.git')).toThrow(
      UnknownGitHostError,
    );
    expect(() => inferRepoSlug('git@gitlab.com:owner/repo.git')).toThrow(
      UnknownGitHostError,
    );
    expect(() => inferRepoSlug('not-a-url')).toThrow(UnknownGitHostError);
  });

  it('throws UnknownGitHostError when path is missing owner/repo split', () => {
    expect(() => inferRepoSlug('https://github.com/onlyone')).toThrow(
      UnknownGitHostError,
    );
  });
});

describe('openPullRequest', () => {
  it('parses standard URL output', async () => {
    const session = new FakeSession({
      scripts: [
        {
          match: ['gh', 'pr', 'create'],
          respond: () => ok('https://github.com/owner/frontend/pull/42'),
        },
      ],
    });

    const result = await openPullRequest({
      session,
      repo: REPO_HTTPS,
      branchName: 'auto-finish/req-1',
      baseBranch: 'main',
      title: 'feat: health endpoint',
      body: 'body',
    });

    expect(result).toEqual({
      pr_url: 'https://github.com/owner/frontend/pull/42',
      pr_number: 42,
    });
    // Confirm slug was passed.
    const created = session.runCalls[0];
    expect(created?.argv).toContain('--repo');
    const idx = created?.argv.indexOf('--repo') ?? -1;
    expect(created?.argv[idx + 1]).toBe('owner/frontend');
  });

  it('parses URL with trailing newline', async () => {
    const session = new FakeSession({
      scripts: [
        {
          match: ['gh', 'pr', 'create'],
          respond: () =>
            ok(
              'Creating pull request for ...\nhttps://github.com/owner/frontend/pull/7\n',
            ),
        },
      ],
    });

    const result = await openPullRequest({
      session,
      repo: REPO_HTTPS,
      branchName: 'auto-finish/req-1',
      baseBranch: 'main',
      title: 't',
      body: 'b',
    });

    expect(result).toEqual({
      pr_url: 'https://github.com/owner/frontend/pull/7',
      pr_number: 7,
    });
  });

  it('falls back to gh pr view when "already exists" is reported', async () => {
    const session = new FakeSession({
      scripts: [
        {
          match: ['gh', 'pr', 'create'],
          respond: () =>
            fail(
              1,
              'a pull request for branch "auto-finish/req-1" already exists\n',
            ),
        },
        {
          match: [
            'gh',
            'pr',
            'view',
            '--head',
            'auto-finish/req-1',
            '--json',
            'url,number',
            '--repo',
            'owner/frontend',
          ],
          respond: () =>
            ok(
              JSON.stringify({
                url: 'https://github.com/owner/frontend/pull/13',
                number: 13,
              }),
            ),
        },
      ],
    });

    const result = await openPullRequest({
      session,
      repo: REPO_HTTPS,
      branchName: 'auto-finish/req-1',
      baseBranch: 'main',
      title: 't',
      body: 'b',
    });

    expect(result).toEqual({
      pr_url: 'https://github.com/owner/frontend/pull/13',
      pr_number: 13,
    });
  });

  it('throws PrCreateError on other create failures', async () => {
    const session = new FakeSession({
      scripts: [
        {
          match: ['gh', 'pr', 'create'],
          respond: () => fail(1, 'authentication required\n'),
        },
      ],
    });

    await expect(
      openPullRequest({
        session,
        repo: REPO_HTTPS,
        branchName: 'auto-finish/req-1',
        baseBranch: 'main',
        title: 't',
        body: 'b',
      }),
    ).rejects.toBeInstanceOf(PrCreateError);
  });
});

describe('editPullRequestBody', () => {
  it('runs gh pr edit with --repo and --body', async () => {
    const session = new FakeSession({
      scripts: [
        {
          match: ['gh', 'pr', 'edit', '42', '--repo', 'owner/frontend'],
          respond: () => ok(),
        },
      ],
    });

    await editPullRequestBody({
      session,
      repo: REPO_HTTPS,
      prNumber: 42,
      body: 'new body\nwith newline',
    });

    const call = session.runCalls[0];
    expect(call?.argv).toEqual([
      'gh',
      'pr',
      'edit',
      '42',
      '--repo',
      'owner/frontend',
      '--body',
      'new body\nwith newline',
    ]);
  });
});
