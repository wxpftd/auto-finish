/**
 * Inject host Claude Code credentials into a sandbox session.
 *
 * Strategy:
 * - Resolve the host credentials path: explicit override > $HOME/.claude/.credentials.json
 *   > $HOME/.config/claude/.credentials.json (older Claude Code layouts).
 * - Upload to the sandbox path (default `/root/.claude/.credentials.json`).
 * - Best-effort `chmod 0600` inside the sandbox; warn but don't fail if the
 *   sandbox lacks chmod (some minimal images do).
 *
 * This file is the only place that knows about credential layout — pipeline
 * runners call it once per sandbox and never touch the path themselves.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SandboxSession } from '../sandbox/interface.js';

export class ClaudeCredentialsNotFoundError extends Error {
  constructor(searched: readonly string[]) {
    super(
      `Claude Code credentials not found. Looked in:\n` +
        searched.map((p) => `  - ${p}`).join('\n') +
        `\nDid you run \`claude login\` on the host? If you want a separate ` +
        `account for auto-finish, run \`claude login\` in a fresh ${'$HOME'} or ` +
        `pass an explicit hostCredentialsPath.`,
    );
    this.name = 'ClaudeCredentialsNotFoundError';
  }
}

export interface InjectClaudeCredentialsArgs {
  session: SandboxSession;
  /** Explicit override; if set, no fallback search is performed. */
  hostCredentialsPath?: string;
  /** Where to place the file inside the sandbox. */
  sandboxCredentialsPath?: string;
  /**
   * Optional logger sink. We use `console.warn` by default; tests inject a
   * spy to assert on warnings without touching global console.
   */
  logger?: { warn: (msg: string) => void };
}

const DEFAULT_SANDBOX_PATH = '/root/.claude/.credentials.json';

/**
 * Resolve the host credentials path.
 *
 * If `explicit` is set, only that path is checked — no fallback. This lets
 * callers pin to a specific location for tests / multi-account scenarios.
 *
 * Otherwise we check, in order:
 *   1. $HOME/.claude/.credentials.json (current Claude Code default)
 *   2. $HOME/.config/claude/.credentials.json (older layout)
 */
export async function resolveHostCredentialsPath(
  explicit?: string,
): Promise<{ path: string; searched: string[] }> {
  if (explicit !== undefined) {
    await fs.access(explicit); // throws if missing — caller catches.
    return { path: explicit, searched: [explicit] };
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { path: candidate, searched: candidates };
    } catch {
      // try next
    }
  }
  throw new ClaudeCredentialsNotFoundError(candidates);
}

/**
 * Copy host credentials into the sandbox and lock them down to 0600.
 *
 * Errors:
 * - Missing credentials => {@link ClaudeCredentialsNotFoundError} (helpful
 *   message naming the searched paths).
 * - Upload failure => propagates the underlying SandboxSession error.
 * - chmod failure => logged warning, function still resolves successfully.
 */
export async function injectClaudeCredentials(
  args: InjectClaudeCredentialsArgs,
): Promise<void> {
  const sandboxPath = args.sandboxCredentialsPath ?? DEFAULT_SANDBOX_PATH;
  const logger = args.logger ?? { warn: (m: string) => console.warn(m) };

  let resolved: { path: string; searched: string[] };
  try {
    resolved = await resolveHostCredentialsPath(args.hostCredentialsPath);
  } catch (err) {
    // If the explicit override was missing, surface a similarly-helpful error.
    if (
      args.hostCredentialsPath !== undefined &&
      !(err instanceof ClaudeCredentialsNotFoundError)
    ) {
      throw new ClaudeCredentialsNotFoundError([args.hostCredentialsPath]);
    }
    throw err;
  }

  await args.session.uploadFile(resolved.path, sandboxPath);

  // Lock down perms inside the sandbox. Tolerate failure: some minimal
  // images (alpine without coreutils) may not have chmod, and the file is
  // still inaccessible to other processes thanks to per-sandbox isolation.
  try {
    const result = await args.session.run(['chmod', '0600', sandboxPath]);
    if (result.exit_code !== 0) {
      logger.warn(
        `injectClaudeCredentials: chmod 0600 ${sandboxPath} exited ${String(result.exit_code)}: ${result.stderr.trim()}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `injectClaudeCredentials: chmod 0600 ${sandboxPath} threw: ${msg}`,
    );
  }
}
