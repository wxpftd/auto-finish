import { describe, expect, it } from 'vitest';
import type { CloneReport } from './clone.js';
import { writeManifest } from './manifest.js';
import { FakeSession } from './__test-utils__/fake-session.js';

const REPORT: CloneReport = {
  cloned: [
    {
      repo_id: 'r-fe',
      working_dir: '/workspace/frontend',
      head_sha: 'aaaa1111',
    },
    {
      repo_id: 'r-be',
      working_dir: '/workspace/backend',
      head_sha: 'bbbb2222',
    },
  ],
  failed: [],
};

describe('writeManifest', () => {
  it('writes JSON at the default path with the correct structure', async () => {
    const session = new FakeSession();

    const manifest = await writeManifest({
      session,
      requirementId: 'req-abc123',
      cloneReport: REPORT,
      now: () => '2026-04-26T10:00:00.000Z',
    });

    expect(manifest).toEqual({
      requirement_id: 'req-abc123',
      created_at: '2026-04-26T10:00:00.000Z',
      repos: [
        {
          id: 'r-fe',
          name: 'frontend',
          working_dir: '/workspace/frontend',
          head_sha: 'aaaa1111',
        },
        {
          id: 'r-be',
          name: 'backend',
          working_dir: '/workspace/backend',
          head_sha: 'bbbb2222',
        },
      ],
    });

    expect(session.writeCalls).toHaveLength(1);
    const call = session.writeCalls[0];
    expect(call?.path).toBe('/workspace/.auto-finish/manifest.json');

    // Bytes must round-trip back to the same JSON.
    const decoded = new TextDecoder().decode(call?.content);
    expect(JSON.parse(decoded)).toEqual(manifest);
    // Pretty-printed (2-space indent) for human review.
    expect(decoded).toContain('\n  "requirement_id"');
  });

  it('honours a custom manifestPath', async () => {
    const session = new FakeSession();
    await writeManifest({
      session,
      requirementId: 'req-x',
      cloneReport: REPORT,
      manifestPath: '/tmp/custom/manifest.json',
      now: () => '2026-04-26T11:00:00.000Z',
    });
    expect(session.writeCalls[0]?.path).toBe('/tmp/custom/manifest.json');
  });

  it('skips failed repos and includes only cloned ones', async () => {
    const session = new FakeSession();
    const report: CloneReport = {
      cloned: [
        {
          repo_id: 'r-fe',
          working_dir: '/workspace/frontend',
          head_sha: 'aaaa1111',
        },
      ],
      failed: [{ repo_id: 'r-be', error: 'network unreachable' }],
    };

    const manifest = await writeManifest({
      session,
      requirementId: 'req-mixed',
      cloneReport: report,
      now: () => '2026-04-26T12:00:00.000Z',
    });

    expect(manifest.repos).toHaveLength(1);
    expect(manifest.repos[0]?.id).toBe('r-fe');
  });

  it('uses resolveName override when provided', async () => {
    const session = new FakeSession();
    const manifest = await writeManifest({
      session,
      requirementId: 'req-x',
      cloneReport: REPORT,
      now: () => '2026-04-26T13:00:00.000Z',
      resolveName: ({ repo_id }) =>
        repo_id === 'r-fe' ? 'web-app' : 'api-server',
    });
    expect(manifest.repos.map((r) => r.name)).toEqual([
      'web-app',
      'api-server',
    ]);
  });
});
