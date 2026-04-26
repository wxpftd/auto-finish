/**
 * PR-publication slice — push branches, open per-repo PRs, cross-link them.
 *
 * Re-exports the public surface plus the typed errors so callers can
 * `instanceof`-check failures.
 */
export type {
  CommitAndPushArgs,
  CommitAndPushResult,
} from './commit-and-push.js';
export { commitAndPush, PushError } from './commit-and-push.js';

export type { OpenPrInput, OpenPrResult } from './gh-pr.js';
export {
  editPullRequestBody,
  inferRepoSlug,
  openPullRequest,
  PrCreateError,
  UnknownGitHostError,
} from './gh-pr.js';

export type {
  BuildCrossLinkedDescriptionsArgs,
  BuiltDescription,
  CrossLinkEntry,
  RepoNameMap,
  SiblingUrlMap,
} from './cross-link.js';
export {
  buildCrossLinkedDescriptions,
  rebuildBodyWithSiblings,
} from './cross-link.js';

export type {
  PublishPullRequestsArgs,
  PublishedPullRequest,
} from './orchestrate.js';
export { publishPullRequests } from './orchestrate.js';
