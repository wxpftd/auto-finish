import { describe, expect, it } from 'vitest';
import type { RepoSpec } from './clone.js';
import { detectChanges, parseNameOnly, parseShortstat } from './diff.js';
import {
  deferred,
  FakeSession,
  fail,
  ok,
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

describe('parseShortstat', () => {
  it('returns zeros on empty output', () => {
    expect(parseShortstat('')).toEqual({
      files_changed: 0,
      insertions: 0,
      deletions: 0,
    });
    expect(parseShortstat('   \n')).toEqual({
      files_changed: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  it('parses the standard form', () => {
    expect(
      parseShortstat(' 2 files changed, 5 insertions(+), 3 deletions(-)\n'),
    ).toEqual({ files_changed: 2, insertions: 5, deletions: 3 });
  });

  it('parses singular file with insertion-only', () => {
    expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({
      files_changed: 1,
      insertions: 1,
      deletions: 0,
    });
  });

  it('parses singular file with deletion-only', () => {
    expect(parseShortstat(' 1 file changed, 1 deletion(-)\n')).toEqual({
      files_changed: 1,
      insertions: 0,
      deletions: 1,
    });
  });

  it('parses multi-digit counts', () => {
    expect(
      parseShortstat(' 47 files changed, 1234 insertions(+), 567 deletions(-)'),
    ).toEqual({ files_changed: 47, insertions: 1234, deletions: 567 });
  });
});

describe('parseNameOnly', () => {
  it('returns [] on empty output', () => {
    expect(parseNameOnly('')).toEqual([]);
    expect(parseNameOnly('\n\n')).toEqual([]);
  });

  it('splits paths and trims trailing newline', () => {
    expect(parseNameOnly('src/a.ts\nsrc/b.ts\n')).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('skips blank lines', () => {
    expect(parseNameOnly('a\n\nb\n')).toEqual(['a', 'b']);
  });
});

describe('detectChanges', () => {
  it('reports per-repo diffs in parallel', async () => {
    const feShortstat = deferred<{
      exit_code: number;
      stdout: string;
      stderr: string;
    }>();

    const session = new FakeSession({
      scripts: [
        // FRONTEND shortstat: gated.
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--shortstat',
            'main',
          ],
          respond: () => feShortstat.promise,
        },
        // FRONTEND name-only: resolves immediately.
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--name-only',
            'main',
          ],
          respond: () => ok('src/App.tsx\nsrc/api.ts\n'),
        },
        // BACKEND shortstat: resolves immediately even though FRONTEND
        // is still gated.
        {
          match: [
            'git',
            '-C',
            BACKEND.working_dir,
            'diff',
            '--shortstat',
            'main',
          ],
          respond: () =>
            ok(' 1 file changed, 12 insertions(+), 1 deletion(-)\n'),
        },
        {
          match: [
            'git',
            '-C',
            BACKEND.working_dir,
            'diff',
            '--name-only',
            'main',
          ],
          respond: () => ok('routes/health.ts\n'),
        },
      ],
    });

    const promise = detectChanges({
      session,
      repos: [FRONTEND, BACKEND],
      baseBranch: 'main',
      workingBranch: 'auto-finish/req-1',
    });

    // Yield long enough for both repos' calls to be issued.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Confirm BACKEND's calls were issued before FRONTEND's gate resolved.
    const backendCalls = session.runCalls.filter(
      (c) => c.argv.includes('/workspace/backend'),
    );
    expect(backendCalls.length).toBeGreaterThanOrEqual(2);

    feShortstat.resolve(ok(' 2 files changed, 8 insertions(+)\n'));

    const result = await promise;
    expect(result).toEqual([
      {
        repo_id: 'r-fe',
        working_dir: '/workspace/frontend',
        has_changes: true,
        files_changed: 2,
        insertions: 8,
        deletions: 0,
        changed_files: ['src/App.tsx', 'src/api.ts'],
      },
      {
        repo_id: 'r-be',
        working_dir: '/workspace/backend',
        has_changes: true,
        files_changed: 1,
        insertions: 12,
        deletions: 1,
        changed_files: ['routes/health.ts'],
      },
    ]);
  });

  it('returns has_changes=false / zeros when shortstat is empty', async () => {
    const session = new FakeSession({
      scripts: [
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--shortstat',
            'main',
          ],
          respond: () => ok(''),
        },
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--name-only',
            'main',
          ],
          respond: () => ok(''),
        },
      ],
    });

    const result = await detectChanges({
      session,
      repos: [FRONTEND],
      baseBranch: 'main',
      workingBranch: 'auto-finish/req-1',
    });

    expect(result).toEqual([
      {
        repo_id: 'r-fe',
        working_dir: '/workspace/frontend',
        has_changes: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        changed_files: [],
      },
    ]);
  });

  it('returns a zeroed RepoDiff when git fails', async () => {
    // Trigger failure via a bogus baseBranch — the new argv shape no longer
    // contains workingBranch, so the failure trigger lives on the base side.
    const session = new FakeSession({
      scripts: [
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--shortstat',
            'nope',
          ],
          respond: () => fail(128, "fatal: ambiguous argument 'nope'\n"),
        },
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--name-only',
            'nope',
          ],
          respond: () => fail(128, ''),
        },
      ],
    });

    const result = await detectChanges({
      session,
      repos: [FRONTEND],
      baseBranch: 'nope',
      workingBranch: 'auto-finish/req-1',
    });

    expect(result).toEqual([
      {
        repo_id: 'r-fe',
        working_dir: '/workspace/frontend',
        has_changes: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        changed_files: [],
      },
    ]);
  });

  it('invokes git diff with <baseBranch> (no triple-dot range)', async () => {
    // Regression test for #8: detectChanges must compare the working tree
    // against <base>, NOT use the commit-range form `<base>...<branch>`.
    // The commit-range form misses the agent's uncommitted Edit/Write output
    // and causes the runner to skip PR creation.
    const session = new FakeSession({
      scripts: [
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--shortstat',
            'main',
          ],
          respond: () => ok(' 1 file changed, 1 insertion(+)\n'),
        },
        {
          match: [
            'git',
            '-C',
            FRONTEND.working_dir,
            'diff',
            '--name-only',
            'main',
          ],
          respond: () => ok('src/touched.ts\n'),
        },
      ],
    });

    await detectChanges({
      session,
      repos: [FRONTEND],
      baseBranch: 'main',
      workingBranch: 'auto-finish/req-1',
    });

    // No argv token may contain the triple-dot range marker.
    for (const c of session.runCalls) {
      for (const tok of c.argv) {
        expect(tok.includes('...')).toBe(false);
      }
    }

    // And the exact shortstat invocation must end with the bare base branch.
    const shortstatCall = session.runCalls.find((c) =>
      c.argv.includes('--shortstat'),
    );
    expect(shortstatCall).toBeDefined();
    expect(shortstatCall?.argv).toEqual([
      'git',
      '-C',
      FRONTEND.working_dir,
      'diff',
      '--shortstat',
      'main',
    ]);
  });
});
