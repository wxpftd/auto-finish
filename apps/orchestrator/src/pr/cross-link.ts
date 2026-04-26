/**
 * Build per-repo PR titles and bodies for a single requirement.
 *
 * Two-phase cross-linking:
 *   Phase 1 (this module): produce initial bodies. Sibling PR URLs are not
 *     known yet, so each entry in the cross-link list is rendered as
 *     `<repo>: pending`.
 *   Phase 2 (in `orchestrate.ts`): once every PR has been opened, rebuild
 *     bodies with real URLs and call `gh pr edit` to update them.
 *
 * Single-repo special case: when there's only one repo there are no siblings,
 * so the entire cross-link section is omitted (not just the bullet list).
 *
 * The cross-link block lists EVERY repo, including the PR's own — that
 * keeps the rendering uniform and lets reviewers visually scan the whole
 * fan-out from any one PR.
 *
 * Default body layout:
 *   <requirement title heading>
 *   <requirement description>
 *   <per-repo block — either a default scaffold or whatever
 *    `perRepoTemplate(entry)` returns>
 *   <cross-link section — only when 2+ repos>
 */
import type { RepoSpec } from '../multi-repo/index.js';
import type { RepoDiff } from '../multi-repo/index.js';

export interface CrossLinkEntry {
  repo: RepoSpec;
  diff: RepoDiff;
  head_sha: string;
}

export interface BuildCrossLinkedDescriptionsArgs {
  requirementId: string;
  requirementTitle: string;
  requirementDescription: string;
  perRepo: CrossLinkEntry[];
  /** Optional override for the per-repo body block (markdown). */
  perRepoTemplate?: (entry: { repo: RepoSpec; diff: RepoDiff }) => string;
}

export interface BuiltDescription {
  repo_id: string;
  title: string;
  body: string;
}

/**
 * Sibling URL map. Keyed by `repo.id` for O(1) lookup; rendering uses
 * `repo.name` so the resulting markdown is human-readable on GitHub.
 * The id→name pairing is supplied separately via `RepoNameMap`.
 */
export type SiblingUrlMap = Map<string, string | null>;
export type RepoNameMap = Map<string, string>;

/**
 * Phase 1 entry point: every sibling URL is `null` → renders as `pending`.
 * Phase 2 call sites build their own `SiblingUrlMap` and call
 * {@link rebuildBodyWithSiblings} for each repo.
 */
export function buildCrossLinkedDescriptions(
  args: BuildCrossLinkedDescriptionsArgs,
): BuiltDescription[] {
  const siblings: SiblingUrlMap = new Map();
  const names: RepoNameMap = new Map();
  for (const entry of args.perRepo) {
    siblings.set(entry.repo.id, null);
    names.set(entry.repo.id, entry.repo.name);
  }
  return args.perRepo.map((entry) => ({
    repo_id: entry.repo.id,
    title: buildTitle(args, entry),
    body: buildBody(args, entry, siblings, names),
  }));
}

/**
 * Phase 2 helper: rebuild a single PR's body with the resolved sibling URL
 * map. Caller should call once per repo after every PR has been opened.
 *
 * `siblings` provides `id → url`; `names` provides `id → display name` for
 * the rendered bullets. Insertion order of `siblings` controls bullet order.
 */
export function rebuildBodyWithSiblings(args: {
  requirementId: string;
  requirementTitle: string;
  requirementDescription: string;
  entry: CrossLinkEntry;
  perRepoTemplate?: (entry: { repo: RepoSpec; diff: RepoDiff }) => string;
  siblings: SiblingUrlMap;
  names: RepoNameMap;
}): string {
  return buildBody(
    {
      requirementId: args.requirementId,
      requirementTitle: args.requirementTitle,
      requirementDescription: args.requirementDescription,
      perRepo: [], // unused in buildBody beyond template lookup
      perRepoTemplate: args.perRepoTemplate,
    },
    args.entry,
    args.siblings,
    args.names,
  );
}

function buildTitle(
  args: BuildCrossLinkedDescriptionsArgs,
  entry: CrossLinkEntry,
): string {
  return `[${entry.repo.name}] ${args.requirementTitle}`;
}

function buildBody(
  args: BuildCrossLinkedDescriptionsArgs,
  entry: CrossLinkEntry,
  siblings: SiblingUrlMap,
  names: RepoNameMap,
): string {
  const sections: string[] = [];

  sections.push(`# ${args.requirementTitle}`);

  const desc = args.requirementDescription.trim();
  if (desc !== '') {
    sections.push(desc);
  }

  const perRepoBlock =
    args.perRepoTemplate?.({ repo: entry.repo, diff: entry.diff }) ??
    defaultPerRepoBlock(entry);
  if (perRepoBlock.trim() !== '') {
    sections.push(perRepoBlock);
  }

  if (siblings.size >= 2) {
    sections.push(buildCrossLinkSection(args.requirementId, siblings, names));
  }

  // Trailing newline-free sentinel that's stable across phases — useful when
  // tests want to assert "the body ends right after the cross-link section".
  return sections.join('\n\n');
}

function defaultPerRepoBlock(entry: CrossLinkEntry): string {
  const lines: string[] = [];
  lines.push(`## Changes in \`${entry.repo.name}\``);
  if (entry.diff.has_changes) {
    lines.push(
      `- Files changed: ${entry.diff.files_changed}`,
      `- Insertions: ${entry.diff.insertions}`,
      `- Deletions: ${entry.diff.deletions}`,
    );
    if (entry.diff.changed_files.length > 0) {
      lines.push('', '<details><summary>Changed files</summary>', '');
      for (const f of entry.diff.changed_files) {
        lines.push(`- \`${f}\``);
      }
      lines.push('', '</details>');
    }
  } else {
    lines.push('_No diff detected._');
  }
  if (entry.head_sha !== '') {
    lines.push('', `HEAD: \`${entry.head_sha}\``);
  }
  return lines.join('\n');
}

function buildCrossLinkSection(
  requirementId: string,
  siblings: SiblingUrlMap,
  names: RepoNameMap,
): string {
  const lines: string[] = [];
  lines.push(`## 🔗 Related PRs (auto-finish requirement ${requirementId})`);
  // Iteration order: insertion order, which is the caller's `perRepo` order.
  // That gives stable rendering across Phase 1 and Phase 2 runs.
  for (const [repoId, url] of siblings) {
    const display = url ?? 'pending';
    // Fall back to the repo id if the name is missing — never produce a
    // bullet starting with `undefined: `.
    const label = names.get(repoId) ?? repoId;
    lines.push(`- ${label}: ${display}`);
  }
  return lines.join('\n');
}
