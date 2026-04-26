/**
 * Tests for the pure warm-fallback module.
 *
 * Detection scans must be conservative — false positives trigger an
 * unnecessary cold sandbox recreate, false negatives leave the original
 * `on_failure` policy in charge. The matrix below covers the canonical
 * dep-failure shapes and a few non-matches that must NOT trigger.
 */

import { describe, it, expect } from 'vitest';
import {
  detectDepInstallFailure,
  snapshotArtifacts,
  restoreArtifacts,
  DEP_FAILURE_PATTERNS,
} from './warm-fallback.js';
import { InMemoryProvider } from '../sandbox/in-memory-provider.js';
import type { StageEvent } from '../db/schema.js';

const ARTIFACTS_ROOT = '/workspace/.auto-finish/artifacts';

function toolResult(content: string, isError = true): StageEvent {
  return {
    type: 'tool_result',
    ts: Date.now(),
    tool_use_id: 'tu-1',
    content,
    is_error: isError,
  };
}

function assistantText(text: string): StageEvent {
  return { type: 'assistant_text', ts: Date.now(), text };
}

describe('detectDepInstallFailure', () => {
  it('returns false for an empty event list', () => {
    expect(detectDepInstallFailure([])).toBe(false);
  });

  it('returns true for a tool_result containing "Read-only file system"', () => {
    const events: StageEvent[] = [
      toolResult(
        "npm ERR! mkdir '/workspace/frontend/node_modules': Read-only file system",
      ),
    ];
    expect(detectDepInstallFailure(events)).toBe(true);
  });

  it('returns true for an EACCES landing in node_modules', () => {
    const events: StageEvent[] = [
      toolResult(
        "EACCES: permission denied, mkdir '/workspace/frontend/node_modules/.cache'",
      ),
    ];
    expect(detectDepInstallFailure(events)).toBe(true);
  });

  it('returns true for an EACCES landing in .venv', () => {
    const events: StageEvent[] = [
      toolResult(
        "PermissionError: [Errno 13] EACCES: '/workspace/backend/.venv/lib'",
      ),
    ];
    expect(detectDepInstallFailure(events)).toBe(true);
  });

  it('returns true when the agent paraphrases the error in assistant_text', () => {
    const events: StageEvent[] = [
      assistantText(
        'I tried to run pnpm install but got "Read-only file system" — looks like the deps cache is mounted RO.',
      ),
    ];
    expect(detectDepInstallFailure(events)).toBe(true);
  });

  it('returns false for an unrelated EACCES (e.g. user home file)', () => {
    const events: StageEvent[] = [
      toolResult(
        "EACCES: permission denied, open '/home/user/foo.txt'",
      ),
    ];
    expect(detectDepInstallFailure(events)).toBe(false);
  });

  it('returns false for a 404 npm error', () => {
    const events: StageEvent[] = [
      toolResult('npm ERR! 404 Not Found - GET https://registry.npmjs.org/missing'),
    ];
    expect(detectDepInstallFailure(events)).toBe(false);
  });

  it('returns false for a generic finished/failed event without payload text', () => {
    const events: StageEvent[] = [
      { type: 'finished', ts: Date.now(), exit_code: 1 },
      { type: 'failed', ts: Date.now(), reason: 'rate limited' },
    ];
    expect(detectDepInstallFailure(events)).toBe(false);
  });

  it('exposes its pattern list as readonly RegExp[]', () => {
    expect(DEP_FAILURE_PATTERNS.length).toBeGreaterThan(0);
    for (const re of DEP_FAILURE_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });
});

describe('snapshotArtifacts / restoreArtifacts', () => {
  it('returns [] when the artifacts root does not exist on the session', async () => {
    const provider = new InMemoryProvider();
    const session = await provider.create({ image: 'test' });
    try {
      const snapshot = await snapshotArtifacts(session);
      expect(snapshot).toEqual([]);
    } finally {
      await session.destroy();
    }
  });

  it('reads every file under the artifacts root', async () => {
    const provider = new InMemoryProvider();
    const session = await provider.create({ image: 'test' });
    try {
      const enc = new TextEncoder();
      await session.writeFile(
        `${ARTIFACTS_ROOT}/需求分析/prd.md`,
        enc.encode('# PRD\n\nbackend /health endpoint'),
      );
      await session.writeFile(
        `${ARTIFACTS_ROOT}/方案设计/design.md`,
        enc.encode('# Design'),
      );
      // A file outside the root must NOT be snapshotted.
      await session.writeFile(
        '/workspace/frontend/README.md',
        enc.encode('readme'),
      );

      const snapshot = await snapshotArtifacts(session);
      expect(snapshot).toHaveLength(2);
      const paths = snapshot.map((s) => s.path).sort();
      expect(paths).toEqual([
        `${ARTIFACTS_ROOT}/方案设计/design.md`,
        `${ARTIFACTS_ROOT}/需求分析/prd.md`,
      ]);
      const prd = snapshot.find((s) => s.path.endsWith('prd.md'))!;
      expect(new TextDecoder().decode(prd.bytes)).toContain('PRD');
    } finally {
      await session.destroy();
    }
  });

  it('restoreArtifacts writes every entry into a fresh session', async () => {
    const provider = new InMemoryProvider();
    const source = await provider.create({ image: 'test' });
    const enc = new TextEncoder();
    await source.writeFile(
      `${ARTIFACTS_ROOT}/需求分析/prd.md`,
      enc.encode('# PRD'),
    );
    await source.writeFile(
      `${ARTIFACTS_ROOT}/方案设计/design.md`,
      enc.encode('# Design'),
    );
    const snapshot = await snapshotArtifacts(source);
    await source.destroy();

    const target = await provider.create({ image: 'test' });
    try {
      await restoreArtifacts(target, snapshot);
      const dec = new TextDecoder();
      const prd = await target.readFile(`${ARTIFACTS_ROOT}/需求分析/prd.md`);
      expect(dec.decode(prd)).toBe('# PRD');
      const design = await target.readFile(
        `${ARTIFACTS_ROOT}/方案设计/design.md`,
      );
      expect(dec.decode(design)).toBe('# Design');
    } finally {
      await target.destroy();
    }
  });

  it('honors a custom artifactsRoot argument', async () => {
    const provider = new InMemoryProvider();
    const session = await provider.create({ image: 'test' });
    try {
      const enc = new TextEncoder();
      await session.writeFile('/custom/root/a.md', enc.encode('a'));
      await session.writeFile('/custom/root/sub/b.md', enc.encode('b'));
      const snapshot = await snapshotArtifacts(session, '/custom/root');
      expect(snapshot).toHaveLength(2);
    } finally {
      await session.destroy();
    }
  });
});
