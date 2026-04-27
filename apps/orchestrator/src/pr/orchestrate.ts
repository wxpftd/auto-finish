/**
 * Top-level "publish PRs for a requirement" flow:
 *
 *   1. Filter to repos with `has_changes: true` (skip the rest silently).
 *   2. Commit + push each in parallel; capture each repo's pushed HEAD sha.
 *   3. Build initial PR descriptions with the cross-link section using
 *      `pending` placeholders for every sibling.
 *   4. Open each PR sequentially (gh CLI rate-limit-friendly + deterministic).
 *   5. Now that we know every PR URL, rebuild bodies with real URLs and
 *      call `gh pr edit` to update each PR.
 *
 * Steps 4 and 5 are sequential by design; step 2 is parallel because git
 * pushes against different repos don't share state and parallelism wins us
 * elapsed-wall-time without any ordering hazard.
 *
 * Repos with no diff are silently skipped — they don't appear in the
 * returned array. Callers that care should reconcile against the input.
 */
import type { SandboxSession } from '../sandbox/interface.js';
import type { RepoDiff, RepoSpec } from '../multi-repo/index.js';

import { commitAndPush } from './commit-and-push.js';
import {
  buildCrossLinkedDescriptions,
  rebuildBodyWithSiblings,
  type CrossLinkEntry,
  type RepoNameMap,
  type SiblingUrlMap,
} from './cross-link.js';
import { editPullRequestBody, openPullRequest } from './gh-pr.js';

export interface PublishPullRequestsArgs {
  session: SandboxSession;
  requirementId: string;
  requirementTitle: string;
  requirementDescription: string;
  perRepo: { repo: RepoSpec; diff: RepoDiff }[];
  /** Map a repo to the base branch its PR should target. */
  baseBranch: (repo: RepoSpec) => string;
  /** Working branch for the requirement (e.g. 'auto-finish/req-abc123'). */
  branchName: string;
  /** Optional commit-message factory; default just echoes the title. */
  commitMessage?: (repo: RepoSpec) => string;
  /** Optional per-repo PR-body block override. */
  perRepoTemplate?: (entry: { repo: RepoSpec; diff: RepoDiff }) => string;
}

export interface PublishedPullRequest {
  repo_id: string;
  pr_url: string;
  pr_number: number;
}

export async function publishPullRequests(
  args: PublishPullRequestsArgs,
): Promise<PublishedPullRequest[]> {
  const {
    session,
    requirementId,
    requirementTitle,
    requirementDescription,
    branchName,
    baseBranch,
  } = args;

  // 1. Filter to repos that actually changed.
  const changed = args.perRepo.filter((p) => p.diff.has_changes);
  if (changed.length === 0) return [];

  // 2. Commit + push in parallel. Each commitAndPush either returns or throws
  // — we let throws propagate; callers may want to retry the whole flow.
  const pushed = await Promise.all(
    changed.map(async (p) => {
      const message =
        args.commitMessage?.(p.repo) ??
        `auto-finish: ${requirementTitle}\n\nrequirement: ${requirementId}`;
      const r = await commitAndPush({
        session,
        repo: p.repo,
        branchName,
        commitMessage: message,
      });
      return { ...p, head_sha: r.head_sha, pushed: r.pushed };
    }),
  );

  // A push that returned `pushed: false` means the working tree was clean —
  // nothing to PR. We don't expect this when has_changes was true, but stay
  // defensive: drop those entries silently.
  const entries: CrossLinkEntry[] = pushed
    .filter((p) => p.pushed)
    .map((p) => ({ repo: p.repo, diff: p.diff, head_sha: p.head_sha }));

  if (entries.length === 0) return [];

  // 3. Phase 1 descriptions (placeholders).
  const phase1 = buildCrossLinkedDescriptions({
    requirementId,
    requirementTitle,
    requirementDescription,
    perRepo: entries,
    ...(args.perRepoTemplate ? { perRepoTemplate: args.perRepoTemplate } : {}),
  });

  // 4. Open PRs sequentially. Build a lookup from repo_id → entry so we can
  // pair phase1 outputs with their repos.
  const entryByRepoId = new Map(entries.map((e) => [e.repo.id, e]));
  const opened: PublishedPullRequest[] = [];
  for (const desc of phase1) {
    const entry = entryByRepoId.get(desc.repo_id);
    if (entry === undefined) continue; // unreachable under normal flow
    const result = await openPullRequest({
      session,
      repo: entry.repo,
      branchName,
      baseBranch: baseBranch(entry.repo),
      title: desc.title,
      body: desc.body,
    });
    opened.push({
      repo_id: desc.repo_id,
      pr_url: result.pr_url,
      pr_number: result.pr_number,
    });
  }

  // 5. Phase 2: rebuild bodies with real URLs, edit each PR.
  const siblings: SiblingUrlMap = new Map();
  const names: RepoNameMap = new Map();
  // Seed entries in the same order phase1 used so the rendering stays stable.
  for (const entry of entries) {
    siblings.set(entry.repo.id, null);
    names.set(entry.repo.id, entry.repo.name);
  }
  for (const o of opened) siblings.set(o.repo_id, o.pr_url);

  // Phase 2 edits are best-effort: if any cross-link edit fails (e.g. GitHub
  // API hiccup, transient auth issue), the PRs themselves are already on the
  // remote and need to be persisted by the caller. Throwing would force the
  // caller's catch path to discard the entire `opened` array — losing track
  // of PRs that genuinely landed. We log a warning and keep going so the
  // caller still gets the populated array back.
  for (const o of opened) {
    const entry = entryByRepoId.get(o.repo_id);
    if (entry === undefined) continue;
    const body = rebuildBodyWithSiblings({
      requirementId,
      requirementTitle,
      requirementDescription,
      entry,
      ...(args.perRepoTemplate
        ? { perRepoTemplate: args.perRepoTemplate }
        : {}),
      siblings,
      names,
    });
    try {
      await editPullRequestBody({
        session,
        repo: entry.repo,
        prNumber: o.pr_number,
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[publishPullRequests] phase-2 cross-link edit failed for PR #${o.pr_number} ` +
          `in ${entry.repo.name}: ${msg}. The PR is open at ${o.pr_url}; its body's ` +
          `"Related PRs" section will show the phase-1 "pending" placeholder.`,
      );
    }
  }

  return opened;
}
