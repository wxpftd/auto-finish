import { describe, expect, it } from 'vitest';

import type { RepoDiff, RepoSpec } from '../multi-repo/index.js';
import {
  buildCrossLinkedDescriptions,
  rebuildBodyWithSiblings,
  type CrossLinkEntry,
  type SiblingUrlMap,
} from './cross-link.js';

const FRONTEND: RepoSpec = {
  id: 'r-fe',
  name: 'frontend',
  git_url: 'https://github.com/owner/frontend.git',
  default_branch: 'main',
  working_dir: '/workspace/frontend',
};

const BACKEND: RepoSpec = {
  id: 'r-be',
  name: 'backend',
  git_url: 'https://github.com/owner/backend.git',
  default_branch: 'main',
  working_dir: '/workspace/backend',
};

function diff(spec: RepoSpec, hasChanges: boolean): RepoDiff {
  return {
    repo_id: spec.id,
    working_dir: spec.working_dir,
    has_changes: hasChanges,
    files_changed: hasChanges ? 2 : 0,
    insertions: hasChanges ? 8 : 0,
    deletions: hasChanges ? 1 : 0,
    changed_files: hasChanges ? ['src/a.ts', 'src/b.ts'] : [],
  };
}

describe('buildCrossLinkedDescriptions', () => {
  it('two-repo case includes both names and a `pending` cross-link line each', () => {
    const entries: CrossLinkEntry[] = [
      { repo: FRONTEND, diff: diff(FRONTEND, true), head_sha: 'abc' },
      { repo: BACKEND, diff: diff(BACKEND, true), head_sha: 'def' },
    ];

    const built = buildCrossLinkedDescriptions({
      requirementId: 'req-1',
      requirementTitle: 'Add /health endpoint',
      requirementDescription: 'Backend exposes /health; frontend shows status.',
      perRepo: entries,
    });

    expect(built).toHaveLength(2);

    for (const desc of built) {
      // Title carries the repo name.
      expect(desc.title.startsWith('[')).toBe(true);
      // Cross-link section header is present.
      expect(desc.body).toContain(
        '## 🔗 Related PRs (auto-finish requirement req-1)',
      );
      // Both repo NAMES appear, both as `pending` (human-readable).
      expect(desc.body).toContain('- frontend: pending');
      expect(desc.body).toContain('- backend: pending');
      // Requirement description is in the body.
      expect(desc.body).toContain(
        'Backend exposes /health; frontend shows status.',
      );
      // Title heading from requirementTitle is in body.
      expect(desc.body).toContain('# Add /health endpoint');
    }

    expect(built[0]?.title).toBe('[frontend] Add /health endpoint');
    expect(built[1]?.title).toBe('[backend] Add /health endpoint');
    expect(built[0]?.repo_id).toBe('r-fe');
    expect(built[1]?.repo_id).toBe('r-be');
  });

  it('single-repo case omits the cross-link section entirely', () => {
    const built = buildCrossLinkedDescriptions({
      requirementId: 'req-2',
      requirementTitle: 'Solo change',
      requirementDescription: 'Just one repo.',
      perRepo: [
        { repo: FRONTEND, diff: diff(FRONTEND, true), head_sha: 'abc' },
      ],
    });

    expect(built).toHaveLength(1);
    const body = built[0]?.body ?? '';
    expect(body).not.toContain('Related PRs');
    expect(body).not.toContain('🔗');
    expect(body).not.toContain('pending');
    expect(body).toContain('Just one repo.');
    expect(body).toContain('# Solo change');
  });

  it('honours a perRepoTemplate override', () => {
    const built = buildCrossLinkedDescriptions({
      requirementId: 'req-3',
      requirementTitle: 'Custom block',
      requirementDescription: 'desc',
      perRepo: [
        { repo: FRONTEND, diff: diff(FRONTEND, true), head_sha: 'abc' },
        { repo: BACKEND, diff: diff(BACKEND, true), head_sha: 'def' },
      ],
      perRepoTemplate: ({ repo }) => `### customised for ${repo.name}`,
    });

    expect(built[0]?.body).toContain('### customised for frontend');
    expect(built[1]?.body).toContain('### customised for backend');
    // The default per-repo block lines should NOT be present.
    expect(built[0]?.body).not.toContain('Files changed: 2');
  });
});

describe('rebuildBodyWithSiblings', () => {
  it('substitutes real URLs in place of `pending`', () => {
    const entries: CrossLinkEntry[] = [
      { repo: FRONTEND, diff: diff(FRONTEND, true), head_sha: 'abc' },
      { repo: BACKEND, diff: diff(BACKEND, true), head_sha: 'def' },
    ];
    const siblings: SiblingUrlMap = new Map([
      ['r-fe', 'https://github.com/owner/frontend/pull/1'],
      ['r-be', 'https://github.com/owner/backend/pull/2'],
    ]);
    const names = new Map([
      ['r-fe', 'frontend'],
      ['r-be', 'backend'],
    ]);

    const body = rebuildBodyWithSiblings({
      requirementId: 'req-1',
      requirementTitle: 'Add /health',
      requirementDescription: 'desc',
      entry: entries[0]!,
      siblings,
      names,
    });

    expect(body).toContain(
      '- frontend: https://github.com/owner/frontend/pull/1',
    );
    expect(body).toContain(
      '- backend: https://github.com/owner/backend/pull/2',
    );
    expect(body).not.toContain('pending');
  });
});
