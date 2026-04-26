import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ClaudeCredentialsNotFoundError,
  injectClaudeCredentials,
} from './credentials.js';
import { FakeSession } from './__test-utils__/fake-session.js';

/**
 * Per-test temp HOME so we can place fake .credentials.json files where
 * the resolver looks. We restore $HOME in afterEach so cross-test pollution
 * is impossible.
 */
let tmpHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-finish-claude-creds-'));
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function writeFakeCreds(rel: string, content: string): Promise<string> {
  const full = path.join(tmpHome, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  return full;
}

describe('injectClaudeCredentials — happy path', () => {
  it('uploads $HOME/.claude/.credentials.json and chmods it 0600', async () => {
    const credsPath = await writeFakeCreds(
      '.claude/.credentials.json',
      '{"token":"xxx"}',
    );
    const session = new FakeSession();
    const warnings: string[] = [];

    await injectClaudeCredentials({
      session,
      logger: { warn: (m: string) => warnings.push(m) },
    });

    expect(session.uploadCalls).toEqual([
      {
        hostPath: credsPath,
        sandboxPath: '/root/.claude/.credentials.json',
      },
    ]);
    expect(session.runCalls).toHaveLength(1);
    expect(session.runCalls[0]?.argv).toEqual([
      'chmod',
      '0600',
      '/root/.claude/.credentials.json',
    ]);
    expect(warnings).toEqual([]);
  });

  it('falls back to $HOME/.config/claude/.credentials.json when default is absent', async () => {
    const credsPath = await writeFakeCreds(
      '.config/claude/.credentials.json',
      '{"token":"yyy"}',
    );
    const session = new FakeSession();

    await injectClaudeCredentials({ session });

    expect(session.uploadCalls).toEqual([
      {
        hostPath: credsPath,
        sandboxPath: '/root/.claude/.credentials.json',
      },
    ]);
  });

  it('respects an explicit hostCredentialsPath without searching defaults', async () => {
    const customDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'auto-finish-creds-custom-'),
    );
    const credsPath = path.join(customDir, 'creds.json');
    await fs.writeFile(credsPath, '{"explicit":true}', 'utf8');

    // Place an "obvious default" candidate in $HOME too — we must NOT pick it.
    await writeFakeCreds('.claude/.credentials.json', '{"should":"not-pick"}');

    const session = new FakeSession();
    await injectClaudeCredentials({
      session,
      hostCredentialsPath: credsPath,
    });

    expect(session.uploadCalls).toEqual([
      {
        hostPath: credsPath,
        sandboxPath: '/root/.claude/.credentials.json',
      },
    ]);

    await fs.rm(customDir, { recursive: true, force: true });
  });

  it('respects a custom sandboxCredentialsPath', async () => {
    await writeFakeCreds('.claude/.credentials.json', '{}');
    const session = new FakeSession();
    await injectClaudeCredentials({
      session,
      sandboxCredentialsPath: '/home/agent/.claude/.credentials.json',
    });
    expect(session.uploadCalls[0]?.sandboxPath).toBe(
      '/home/agent/.claude/.credentials.json',
    );
    expect(session.runCalls[0]?.argv).toEqual([
      'chmod',
      '0600',
      '/home/agent/.claude/.credentials.json',
    ]);
  });
});

describe('injectClaudeCredentials — missing creds', () => {
  it('throws ClaudeCredentialsNotFoundError mentioning both default paths and `claude login`', async () => {
    // No files written under tmpHome at all.
    const session = new FakeSession();

    await expect(injectClaudeCredentials({ session })).rejects.toMatchObject({
      name: 'ClaudeCredentialsNotFoundError',
    });

    // The error message should be helpful: list searched paths + claude login hint.
    let caught: unknown;
    try {
      await injectClaudeCredentials({ session });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeCredentialsNotFoundError);
    const err = caught as Error;
    expect(err.message).toMatch(/\.claude\/\.credentials\.json/);
    expect(err.message).toMatch(/\.config\/claude\/\.credentials\.json/);
    expect(err.message).toMatch(/claude login/);
  });

  it('throws a helpful error when an explicit hostCredentialsPath does not exist', async () => {
    const session = new FakeSession();
    await expect(
      injectClaudeCredentials({
        session,
        hostCredentialsPath: '/this/does/not/exist.json',
      }),
    ).rejects.toMatchObject({ name: 'ClaudeCredentialsNotFoundError' });
  });
});

describe('injectClaudeCredentials — chmod resilience', () => {
  it('logs a warning but does NOT throw when chmod returns non-zero', async () => {
    await writeFakeCreds('.claude/.credentials.json', '{}');
    const session = new FakeSession({
      defaultRunResult: {
        exit_code: 1,
        stdout: '',
        stderr: 'chmod: not supported\n',
      },
    });
    const warnings: string[] = [];

    await expect(
      injectClaudeCredentials({
        session,
        logger: { warn: (m: string) => warnings.push(m) },
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/chmod 0600/);
    expect(warnings[0]).toMatch(/exited 1/);
  });

  it('logs a warning but does NOT throw when chmod throws (e.g. command not found)', async () => {
    await writeFakeCreds('.claude/.credentials.json', '{}');
    const session = new FakeSession({
      runError: new Error('chmod: command not found'),
    });
    const warnings: string[] = [];

    await expect(
      injectClaudeCredentials({
        session,
        logger: { warn: (m: string) => warnings.push(m) },
      }),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/chmod 0600/);
    expect(warnings[0]).toMatch(/threw/);
    // upload must still have happened.
    expect(session.uploadCalls).toHaveLength(1);
  });
});
