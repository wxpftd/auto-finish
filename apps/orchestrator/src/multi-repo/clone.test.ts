import { describe, expect, it } from 'vitest';
import { cloneRepos } from './clone.js';
import type { RepoSpec } from './clone.js';
import {
  deferred,
  FakeSession,
  fail,
  ok,
  type RunScript,
} from './__test-utils__/fake-session.js';

const FRONTEND: RepoSpec = {
  id: 'r-fe',
  name: 'frontend',
  git_url: 'https://example.com/frontend.git',
  default_branch: 'main',
  working_dir: '/workspace/frontend',
};

const BACKEND: RepoSpec = {
  id: 'r-be',
  name: 'backend',
  git_url: 'https://example.com/backend.git',
  default_branch: 'main',
  working_dir: '/workspace/backend',
};

/** Build the happy-path 5-step script for one repo. */
function happyScripts(repo: RepoSpec, branch: string, sha: string): RunScript[] {
  return [
    {
      match: ['mkdir', '-p', '/workspace'],
      respond: () => ok(),
    },
    {
      match: [
        'git',
        'clone',
        '--depth',
        '50',
        '--branch',
        repo.default_branch,
        repo.git_url,
        repo.working_dir,
      ],
      respond: () => ok(),
    },
    {
      match: ['git', '-C', repo.working_dir, 'checkout', '-b', branch],
      respond: () => ok(),
    },
    {
      match: ['git', '-C', repo.working_dir, 'rev-parse', 'HEAD'],
      respond: () => ok(`${sha}\n`),
    },
  ];
}

describe('cloneRepos', () => {
  it('clones two repos happily and reports both', async () => {
    const branch = 'auto-finish/req-abc123';
    const session = new FakeSession({
      scripts: [
        ...happyScripts(FRONTEND, branch, 'aaaa1111'),
        ...happyScripts(BACKEND, branch, 'bbbb2222'),
      ],
    });

    const report = await cloneRepos({
      session,
      repos: [FRONTEND, BACKEND],
      branchName: branch,
    });

    expect(report.failed).toEqual([]);
    expect(report.cloned).toEqual([
      {
        repo_id: 'r-fe',
        working_dir: '/workspace/frontend',
        head_sha: 'aaaa1111',
      },
      {
        repo_id: 'r-be',
        working_dir: '/workspace/backend',
        head_sha: 'bbbb2222',
      },
    ]);
  });

  it('emits the correct argv sequence per repo when gitAuthor is set', async () => {
    const branch = 'auto-finish/req-xyz';
    const session = new FakeSession({
      scripts: [
        { match: ['mkdir', '-p', '/workspace'], respond: () => ok() },
        {
          match: [
            'git',
            'clone',
            '--depth',
            '50',
            '--branch',
            'main',
            FRONTEND.git_url,
            FRONTEND.working_dir,
          ],
          respond: () => ok(),
        },
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'checkout',
            '-b',
            branch,
          ],
          respond: () => ok(),
        },
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'config',
            'user.name',
            'Auto Finish Bot',
          ],
          respond: () => ok(),
        },
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'config',
            'user.email',
            'auto@example.com',
          ],
          respond: () => ok(),
        },
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'rev-parse',
            'HEAD',
          ],
          respond: () => ok('feed1234\n'),
        },
      ],
    });

    const report = await cloneRepos({
      session,
      repos: [FRONTEND],
      branchName: branch,
      gitAuthor: { name: 'Auto Finish Bot', email: 'auto@example.com' },
    });

    expect(report.failed).toEqual([]);
    expect(report.cloned).toHaveLength(1);
    expect(report.cloned[0]?.head_sha).toBe('feed1234');

    // Multi-word author name must arrive as ONE argv element.
    const cfgName = session.runCalls.find(
      (c) => c.argv[3] === 'config' && c.argv[4] === 'user.name',
    );
    expect(cfgName?.argv).toEqual([
      'git',
      '-C',
      '/workspace/frontend',
      'config',
      'user.name',
      'Auto Finish Bot',
    ]);
  });

  it('reports failure when git clone exits non-zero, succeeding on the other repo', async () => {
    const branch = 'auto-finish/req-fail-1';
    const session = new FakeSession({
      scripts: [
        // FRONTEND succeeds.
        ...happyScripts(FRONTEND, branch, '1111aaaa'),
        // BACKEND: mkdir ok, clone fails.
        { match: ['mkdir', '-p', '/workspace'], respond: () => ok() },
        {
          match: [
            'git',
            'clone',
            '--depth',
            '50',
            '--branch',
            'main',
            BACKEND.git_url,
            BACKEND.working_dir,
          ],
          respond: () =>
            fail(128, 'fatal: unable to access: network unreachable\n'),
        },
      ],
    });

    const report = await cloneRepos({
      session,
      repos: [FRONTEND, BACKEND],
      branchName: branch,
    });

    expect(report.cloned).toHaveLength(1);
    expect(report.cloned[0]?.repo_id).toBe('r-fe');

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.repo_id).toBe('r-be');
    expect(report.failed[0]?.error).toMatch(/git clone failed/);
    expect(report.failed[0]?.error).toMatch(/network unreachable/);
  });

  it('skips later steps when an earlier step fails (sequential per-repo)', async () => {
    const branch = 'auto-finish/req-fail-2';
    const session = new FakeSession({
      scripts: [
        { match: ['mkdir', '-p', '/workspace'], respond: () => ok() },
        {
          match: ['git', 'clone'],
          respond: () => fail(1, 'permission denied\n'),
        },
      ],
    });

    const report = await cloneRepos({
      session,
      repos: [FRONTEND],
      branchName: branch,
    });

    expect(report.cloned).toEqual([]);
    expect(report.failed).toHaveLength(1);

    // Only mkdir + clone should have been attempted; checkout / rev-parse
    // must NOT have run.
    const argvs = session.runCalls.map((c) => c.argv);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]?.[0]).toBe('mkdir');
    expect(argvs[1]?.[0]).toBe('git');
    expect(argvs[1]?.[1]).toBe('clone');
  });

  it('runs different repos in parallel (overlap by ordered timestamps)', async () => {
    const branch = 'auto-finish/req-par';

    // Defer FRONTEND's mkdir so we can prove BACKEND's mkdir was issued
    // BEFORE FRONTEND's mkdir even resolved.
    const feMkdirGate = deferred<{
      exit_code: number;
      stdout: string;
      stderr: string;
    }>();

    const session = new FakeSession({
      scripts: [
        // FRONTEND mkdir: we pause this one.
        {
          match: ['mkdir', '-p', '/workspace'],
          respond: () => feMkdirGate.promise,
        },
        // BACKEND mkdir: resolves immediately.
        {
          match: ['mkdir', '-p', '/workspace'],
          respond: () => ok(),
        },
        // Rest of BACKEND happy-path.
        {
          match: [
            'git',
            'clone',
            '--depth',
            '50',
            '--branch',
            'main',
            BACKEND.git_url,
            BACKEND.working_dir,
          ],
          respond: () => ok(),
        },
        {
          match: ['git', '-C', BACKEND.working_dir, 'checkout', '-b', branch],
          respond: () => ok(),
        },
        {
          match: ['git', '-C', BACKEND.working_dir, 'rev-parse', 'HEAD'],
          respond: () => ok('beefcafe\n'),
        },
        // Rest of FRONTEND happy-path (after we let mkdir through).
        {
          match: [
            'git',
            'clone',
            '--depth',
            '50',
            '--branch',
            'main',
            FRONTEND.git_url,
            FRONTEND.working_dir,
          ],
          respond: () => ok(),
        },
        {
          match: ['git', '-C', FRONTEND.working_dir, 'checkout', '-b', branch],
          respond: () => ok(),
        },
        {
          match: ['git', '-C', FRONTEND.working_dir, 'rev-parse', 'HEAD'],
          respond: () => ok('1357acef\n'),
        },
      ],
    });

    const reportPromise = cloneRepos({
      session,
      repos: [FRONTEND, BACKEND],
      branchName: branch,
    });

    // Yield the event loop so both repo workers' first call lands.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Both mkdir calls should be visible BEFORE FRONTEND's mkdir resolves.
    const mkdirCalls = session.runCalls.filter((c) => c.argv[0] === 'mkdir');
    expect(mkdirCalls.length).toBe(2);

    // And BACKEND's pipeline should have advanced past mkdir even though
    // FRONTEND is still gated.
    const backendCalls = session.runCalls.filter(
      (c) =>
        c.argv.includes('/workspace/backend') ||
        (c.argv[0] === 'git' &&
          c.argv[1] === 'clone' &&
          c.argv.includes(BACKEND.git_url)),
    );
    expect(backendCalls.length).toBeGreaterThan(0);

    // No FRONTEND git calls yet — its pipeline is still blocked on mkdir.
    const frontendGitCalls = session.runCalls.filter(
      (c) =>
        c.argv[0] === 'git' &&
        (c.argv.includes('/workspace/frontend') ||
          c.argv.includes(FRONTEND.git_url)),
    );
    expect(frontendGitCalls.length).toBe(0);

    feMkdirGate.resolve(ok());
    const report = await reportPromise;
    expect(report.failed).toEqual([]);
    expect(report.cloned).toHaveLength(2);
  });
});
