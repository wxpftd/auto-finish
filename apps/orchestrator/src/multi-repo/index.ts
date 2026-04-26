/**
 * Multi-repo orchestration: clone N repos into one sandbox per requirement,
 * persist a manifest, and detect post-agent diffs.
 */
export type {
  CloneFailure,
  CloneReport,
  CloneReposArgs,
  CloneSuccess,
  GitAuthor,
  RepoSpec,
} from './clone.js';
export { cloneRepos } from './clone.js';

export type {
  RepoManifest,
  RepoManifestEntry,
  WriteManifestArgs,
} from './manifest.js';
export { writeManifest } from './manifest.js';

export type { DetectChangesArgs, RepoDiff } from './diff.js';
export { detectChanges, parseNameOnly, parseShortstat } from './diff.js';
