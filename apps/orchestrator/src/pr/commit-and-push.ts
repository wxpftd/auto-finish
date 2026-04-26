/**
 * Stage every working-tree change in a repo, commit it, and push the branch
 * (with -u so the upstream is set on first push). Returns a flag indicating
 * whether anything was actually pushed plus the resulting HEAD sha.
 *
 * No shell interpolation: every git invocation is the argv form, so commit
 * messages with spaces, newlines, or shell metacharacters travel safely.
 *
 * If `git diff --cached --quiet` exits 0, nothing is staged → we short-circuit
 * with `{ pushed: false, head_sha: '' }`. Empty sha is the chosen sentinel for
 * "no push happened"; callers should branch on `pushed` rather than the sha
 * (commented inline below).
 *
 * Push failures throw `PushError` so the caller can surface stderr to the user.
 */
import type { SandboxSession } from '../sandbox/interface.js';
import type { RepoSpec } from '../multi-repo/index.js';

export interface CommitAndPushArgs {
  session: SandboxSession;
  repo: RepoSpec;
  branchName: string;
  /** Pre-generated commit message; written as a single argv element. */
  commitMessage: string;
  /** Optional remote name; default 'origin'. */
  remote?: string;
}

export interface CommitAndPushResult {
  pushed: boolean;
  head_sha: string;
}

export class PushError extends Error {
  override readonly name = 'PushError';
  readonly stderr: string;
  readonly exit_code: number;
  readonly stage:
    | 'add'
    | 'diff_cached'
    | 'commit'
    | 'push'
    | 'rev_parse';

  constructor(
    stage: PushError['stage'],
    message: string,
    exit_code: number,
    stderr: string,
  ) {
    super(message);
    this.stage = stage;
    this.exit_code = exit_code;
    this.stderr = stderr;
  }
}

export async function commitAndPush(
  args: CommitAndPushArgs,
): Promise<CommitAndPushResult> {
  const { session, repo, branchName, commitMessage } = args;
  const remote = args.remote ?? 'origin';
  const wd = repo.working_dir;

  // 1. Stage everything in the working tree.
  const addRes = await session.run(['git', '-C', wd, 'add', '-A']);
  if (addRes.exit_code !== 0) {
    throw new PushError(
      'add',
      `git add -A failed for ${repo.name}: ${addRes.stderr || addRes.stdout}`,
      addRes.exit_code,
      addRes.stderr,
    );
  }

  // 2. Probe the index. `--quiet` makes git exit 0 when clean and 1 when
  // there are staged changes (other exits = real error).
  const diffRes = await session.run([
    'git',
    '-C',
    wd,
    'diff',
    '--cached',
    '--quiet',
  ]);
  if (diffRes.exit_code === 0) {
    // Nothing staged → nothing to commit/push. Empty sha is the
    // "no-push" sentinel; callers should branch on `pushed`.
    return { pushed: false, head_sha: '' };
  }
  if (diffRes.exit_code !== 1) {
    throw new PushError(
      'diff_cached',
      `git diff --cached --quiet returned unexpected exit ${diffRes.exit_code}: ${diffRes.stderr || diffRes.stdout}`,
      diffRes.exit_code,
      diffRes.stderr,
    );
  }

  // 3. Commit. The commit message is passed as a single argv element so
  // newlines, quotes, and shell metacharacters are safe.
  const commitRes = await session.run([
    'git',
    '-C',
    wd,
    'commit',
    '-m',
    commitMessage,
  ]);
  if (commitRes.exit_code !== 0) {
    throw new PushError(
      'commit',
      `git commit failed for ${repo.name}: ${commitRes.stderr || commitRes.stdout}`,
      commitRes.exit_code,
      commitRes.stderr,
    );
  }

  // 4. Push and set upstream.
  const pushRes = await session.run([
    'git',
    '-C',
    wd,
    'push',
    '-u',
    remote,
    branchName,
  ]);
  if (pushRes.exit_code !== 0) {
    throw new PushError(
      'push',
      `git push -u ${remote} ${branchName} failed for ${repo.name}: ${pushRes.stderr || pushRes.stdout}`,
      pushRes.exit_code,
      pushRes.stderr,
    );
  }

  // 5. Capture the pushed HEAD sha.
  const shaRes = await session.run(['git', '-C', wd, 'rev-parse', 'HEAD']);
  if (shaRes.exit_code !== 0) {
    throw new PushError(
      'rev_parse',
      `git rev-parse HEAD failed for ${repo.name}: ${shaRes.stderr || shaRes.stdout}`,
      shaRes.exit_code,
      shaRes.stderr,
    );
  }
  const head_sha = shaRes.stdout.trim();
  if (head_sha === '') {
    throw new PushError(
      'rev_parse',
      `git rev-parse HEAD produced empty output for ${repo.name}`,
      shaRes.exit_code,
      shaRes.stderr,
    );
  }

  return { pushed: true, head_sha };
}
