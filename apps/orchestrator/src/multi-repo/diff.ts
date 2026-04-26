/**
 * After agent work, detect which repos actually changed so the PR-creator
 * (Phase 2) only opens PRs for the repos that need them.
 *
 * Per repo we ask git two questions:
 *   1. shape of the change set — `git diff --shortstat <base>`
 *   2. exact files touched   — `git diff --name-only <base>`
 *
 * NOTE on the diff form: we use `git diff <base>` (no `...` triple-dot) on
 * purpose. The runner's flow is clone → claude edits via Edit/Write tool
 * (working tree, NOT committed) → detectChanges → publishPullRequests.
 * `git diff <base>...<branch>` (commit-range) only sees committed diffs,
 * so it would return empty for any stage that uses Edit/Write without a
 * commit step — and the runner would skip the PR. `git diff <base>`
 * compares the working tree against `<base>` and therefore captures BOTH
 * committed and uncommitted differences in one shot, which matches the
 * "what would a PR show" semantic the runner needs.
 *
 * Caveat: brand-new untracked files are NOT detected by `git diff` (only
 * tracked-file edits and deletions). If a stage creates wholly new files,
 * the runner should `git add -A` (or stage them via the agent) before
 * calling detectChanges. We deliberately keep `git diff` here rather than
 * `git status --porcelain` because the goal is parity with what the PR
 * will actually show.
 *
 * Both commands run via `session.run` so transport errors surface as
 * exceptions and non-zero exits surface as `{ exit_code, stderr }` payloads.
 * We treat any git failure as "no changes detected" with a defensive zeroed
 * payload — the caller decides how strict to be about that.
 */
import type { SandboxSession } from '../sandbox/interface.js';
import type { RepoSpec } from './clone.js';

export interface RepoDiff {
  repo_id: string;
  working_dir: string;
  has_changes: boolean;
  files_changed: number;
  insertions: number;
  deletions: number;
  changed_files: string[];
}

export interface DetectChangesArgs {
  session: SandboxSession;
  repos: RepoSpec[];
  /** Branch we diverged from, e.g. 'main'. Used as the diff base. */
  baseBranch: string;
  /**
   * Branch the agent worked on, e.g. 'auto-finish/req-abc123'. Not used by
   * the diff itself (we compare working tree vs base, see file header) —
   * retained in the args shape because callers carry it through to the
   * manifest / PR layer. Kept for signature stability.
   */
  workingBranch: string;
}

export async function detectChanges(
  args: DetectChangesArgs,
): Promise<RepoDiff[]> {
  const { session, repos, baseBranch } = args;
  // workingBranch is intentionally unused here — see DetectChangesArgs JSDoc.
  // Different repos are independent — run in parallel. Within a repo we
  // run shortstat and name-only in parallel too, since they don't share state.
  const out = await Promise.all(
    repos.map((repo) => diffOneRepo(session, repo, baseBranch)),
  );
  return out;
}

async function diffOneRepo(
  session: SandboxSession,
  repo: RepoSpec,
  baseBranch: string,
): Promise<RepoDiff> {
  const empty: RepoDiff = {
    repo_id: repo.id,
    working_dir: repo.working_dir,
    has_changes: false,
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    changed_files: [],
  };

  const [shortstatRes, nameOnlyRes] = await Promise.all([
    safeRun(session, [
      'git',
      '-C',
      repo.working_dir,
      'diff',
      '--shortstat',
      baseBranch,
    ]),
    safeRun(session, [
      'git',
      '-C',
      repo.working_dir,
      'diff',
      '--name-only',
      baseBranch,
    ]),
  ]);

  // If either command failed, return an empty diff. This keeps detectChanges
  // total: a partial outage doesn't crash the rest of the pipeline.
  if (shortstatRes === undefined || nameOnlyRes === undefined) {
    return empty;
  }
  if (shortstatRes.exit_code !== 0 || nameOnlyRes.exit_code !== 0) {
    return empty;
  }

  const shortstat = parseShortstat(shortstatRes.stdout);
  const changed_files = parseNameOnly(nameOnlyRes.stdout);

  const has_changes =
    shortstat.files_changed > 0 ||
    shortstat.insertions > 0 ||
    shortstat.deletions > 0 ||
    changed_files.length > 0;

  return {
    repo_id: repo.id,
    working_dir: repo.working_dir,
    has_changes,
    files_changed: shortstat.files_changed,
    insertions: shortstat.insertions,
    deletions: shortstat.deletions,
    changed_files,
  };
}

interface ShortstatCounts {
  files_changed: number;
  insertions: number;
  deletions: number;
}

/**
 * Parse `git diff --shortstat` output. Examples:
 *
 *   ""                                              → all zeros
 *   " 2 files changed, 5 insertions(+), 3 deletions(-)"
 *   " 1 file changed, 1 insertion(+)"               (singular, no deletions)
 *   " 1 file changed, 1 deletion(-)"                (no insertions)
 *
 * Each clause is matched independently so any combination works.
 */
export function parseShortstat(output: string): ShortstatCounts {
  const counts: ShortstatCounts = {
    files_changed: 0,
    insertions: 0,
    deletions: 0,
  };
  if (output.trim() === '') return counts;

  const filesMatch = output.match(/(\d+)\s+files?\s+changed/);
  const insMatch = output.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = output.match(/(\d+)\s+deletions?\(-\)/);

  // noUncheckedIndexedAccess: match groups are `string | undefined`.
  if (filesMatch && filesMatch[1] !== undefined) {
    counts.files_changed = parseIntSafe(filesMatch[1]);
  }
  if (insMatch && insMatch[1] !== undefined) {
    counts.insertions = parseIntSafe(insMatch[1]);
  }
  if (delMatch && delMatch[1] !== undefined) {
    counts.deletions = parseIntSafe(delMatch[1]);
  }
  return counts;
}

/** Split `--name-only` output, trimming the trailing newline / blanks. */
export function parseNameOnly(output: string): string[] {
  if (output === '') return [];
  return output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntSafe(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

async function safeRun(
  session: SandboxSession,
  argv: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string } | undefined> {
  try {
    return await session.run(argv);
  } catch {
    // Transport errors → "no diff info available".
    return undefined;
  }
}
