/**
 * Capture full `git diff <base>` patch text for a single repo.
 *
 * Sibling to `multi-repo/diff.ts` (which only collects shortstat + name-only):
 * the runner uses this module when persisting a diff artifact so the dashboard
 * can render a real patch. Same git-form as `diff.ts` (NO `...` triple-dot —
 * see CLAUDE.md "Multi-repo `git diff` convention" and the file header in
 * `diff.ts` for the reasoning).
 *
 * Returns an empty string on any git failure: the runner treats "no diff
 * available" as benign — better than aborting the run because diff capture
 * failed.
 */
import type { SandboxSession } from '../sandbox/interface.js';
import type { RepoSpec } from './clone.js';

export interface GetDiffPatchArgs {
  session: SandboxSession;
  repo: RepoSpec;
  baseBranch: string;
}

export async function getDiffPatch(args: GetDiffPatchArgs): Promise<string> {
  try {
    const result = await args.session.run([
      'git',
      '-C',
      args.repo.working_dir,
      'diff',
      args.baseBranch,
    ]);
    if (result.exit_code !== 0) return '';
    return result.stdout;
  } catch {
    return '';
  }
}
