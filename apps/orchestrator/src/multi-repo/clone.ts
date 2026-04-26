/**
 * Clone all repos for a single requirement into one sandbox, side-by-side
 * under `/workspace/`. Each repo gets the same working branch
 * (`auto-finish/req-{id}`) so the agent sees a consistent topology.
 *
 * Per-repo steps run sequentially (mkdir → clone → checkout → config → sha),
 * but DIFFERENT repos run in parallel via Promise.allSettled — they don't
 * share state. Failures (network errors, missing branches) are collected
 * into the `failed[]` slot of the report rather than thrown, so a partial
 * success can still produce a usable manifest.
 */
import * as path from 'node:path';
import type { SandboxSession } from '../sandbox/interface.js';

export interface RepoSpec {
  id: string;
  /** Unique within project; used as a stable key in reports/manifests. */
  name: string;
  git_url: string;
  /** e.g. 'main' — the branch to clone and to base the working branch on. */
  default_branch: string;
  /** Sandbox-relative absolute path, e.g. '/workspace/frontend'. */
  working_dir: string;
}

export interface GitAuthor {
  name: string;
  email: string;
}

export interface CloneSuccess {
  repo_id: string;
  working_dir: string;
  head_sha: string;
}

export interface CloneFailure {
  repo_id: string;
  error: string;
}

export interface CloneReport {
  cloned: CloneSuccess[];
  failed: CloneFailure[];
}

export interface CloneReposArgs {
  session: SandboxSession;
  repos: RepoSpec[];
  /** e.g. 'auto-finish/req-abc123'. Same branch name across all repos. */
  branchName: string;
  gitAuthor?: GitAuthor;
}

const SHALLOW_DEPTH = 50;

export async function cloneRepos(args: CloneReposArgs): Promise<CloneReport> {
  const { session, repos, branchName, gitAuthor } = args;

  // Promise.allSettled is the natural shape: each repo's pipeline is
  // independent. doRepo never rejects (it converts errors to a failure
  // record), so allSettled is belt-and-braces — but it documents intent.
  const results = await Promise.allSettled(
    repos.map((repo) => cloneOneRepo(session, repo, branchName, gitAuthor)),
  );

  const cloned: CloneSuccess[] = [];
  const failed: CloneFailure[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const repo = repos[i];
    if (result === undefined || repo === undefined) continue;
    if (result.status === 'fulfilled') {
      const v = result.value;
      if ('head_sha' in v) {
        cloned.push(v);
      } else {
        failed.push(v);
      }
    } else {
      // doRepo doesn't throw, but if it ever does we still want a clean record.
      const err = result.reason;
      failed.push({ repo_id: repo.id, error: errorMessage(err) });
    }
  }

  return { cloned, failed };
}

type RepoOutcome = CloneSuccess | CloneFailure;

async function cloneOneRepo(
  session: SandboxSession,
  repo: RepoSpec,
  branchName: string,
  gitAuthor: GitAuthor | undefined,
): Promise<RepoOutcome> {
  // 1. mkdir -p <parent>. Sandbox paths are POSIX even on macOS.
  const parent = path.posix.dirname(repo.working_dir);
  try {
    const mkdir = await session.run(['mkdir', '-p', parent]);
    if (mkdir.exit_code !== 0) {
      return repoFailure(repo, `mkdir failed: ${mkdir.stderr || mkdir.stdout}`);
    }
  } catch (err) {
    return repoFailure(repo, `mkdir error: ${errorMessage(err)}`);
  }

  // 2. git clone --depth <N> --branch <default> <url> <wd>.
  // Failure here is tolerated and reported.
  try {
    const clone = await session.run([
      'git',
      'clone',
      '--depth',
      String(SHALLOW_DEPTH),
      '--branch',
      repo.default_branch,
      repo.git_url,
      repo.working_dir,
    ]);
    if (clone.exit_code !== 0) {
      return repoFailure(
        repo,
        `git clone failed (exit ${clone.exit_code}): ${
          clone.stderr || clone.stdout
        }`,
      );
    }
  } catch (err) {
    return repoFailure(repo, `git clone error: ${errorMessage(err)}`);
  }

  // 3. git -C <wd> checkout -b <branch>.
  try {
    const checkout = await session.run([
      'git',
      '-C',
      repo.working_dir,
      'checkout',
      '-b',
      branchName,
    ]);
    if (checkout.exit_code !== 0) {
      return repoFailure(
        repo,
        `git checkout -b ${branchName} failed: ${
          checkout.stderr || checkout.stdout
        }`,
      );
    }
  } catch (err) {
    return repoFailure(repo, `git checkout error: ${errorMessage(err)}`);
  }

  // 4. (optional) git config user.name/user.email — set per-repo so future
  // auto-commits use the configured identity without leaking host config.
  if (gitAuthor !== undefined) {
    try {
      const cfgName = await session.run([
        'git',
        '-C',
        repo.working_dir,
        'config',
        'user.name',
        gitAuthor.name,
      ]);
      if (cfgName.exit_code !== 0) {
        return repoFailure(
          repo,
          `git config user.name failed: ${cfgName.stderr || cfgName.stdout}`,
        );
      }
      const cfgEmail = await session.run([
        'git',
        '-C',
        repo.working_dir,
        'config',
        'user.email',
        gitAuthor.email,
      ]);
      if (cfgEmail.exit_code !== 0) {
        return repoFailure(
          repo,
          `git config user.email failed: ${
            cfgEmail.stderr || cfgEmail.stdout
          }`,
        );
      }
    } catch (err) {
      return repoFailure(repo, `git config error: ${errorMessage(err)}`);
    }
  }

  // 5. git rev-parse HEAD — captures the commit we just branched off of so
  // diff detection can reason about what the agent added.
  let headSha: string;
  try {
    const head = await session.run([
      'git',
      '-C',
      repo.working_dir,
      'rev-parse',
      'HEAD',
    ]);
    if (head.exit_code !== 0) {
      return repoFailure(
        repo,
        `git rev-parse HEAD failed: ${head.stderr || head.stdout}`,
      );
    }
    headSha = head.stdout.trim();
    if (headSha === '') {
      return repoFailure(repo, 'git rev-parse HEAD produced empty output');
    }
  } catch (err) {
    return repoFailure(repo, `git rev-parse error: ${errorMessage(err)}`);
  }

  return {
    repo_id: repo.id,
    working_dir: repo.working_dir,
    head_sha: headSha,
  };
}

function repoFailure(repo: RepoSpec, error: string): CloneFailure {
  return { repo_id: repo.id, error };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
