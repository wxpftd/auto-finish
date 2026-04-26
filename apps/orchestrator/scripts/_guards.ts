/**
 * Shared credential / dependency guards for smoke scripts.
 *
 * Each guard either returns silently (the prerequisite is satisfied) or
 * prints a single line beginning with `SKIPPED:` to stdout and calls
 * `process.exit(0)`. The smoke harness (`smoke-all.ts`) greps the captured
 * stdout for that prefix to distinguish a clean SKIP from a genuine PASS;
 * both are exit code 0 but reported differently.
 *
 * Design notes:
 *   - Guards perform synchronous-style checks where possible (binary
 *     existence) and fall back to spawning sub-processes only when we
 *     actually need to verify auth state (`gh auth status`).
 *   - We deliberately do NOT throw — calling code can rely on the guard to
 *     exit the process directly, which keeps the smoke scripts' main()
 *     bodies linear with no try/catch boilerplate.
 */

import { spawnSync } from 'node:child_process';

/**
 * Print a SKIPPED line and exit 0. This is the only way the smoke harness
 * recognises a skip — the prefix `SKIPPED:` MUST appear at the start of a
 * stdout line (we put it on its own line, no other prefix).
 */
function skip(reason: string): never {
  // eslint-disable-next-line no-console
  console.log(`SKIPPED: ${reason}`);
  process.exit(0);
}

/**
 * True iff `cmd --version` (or a similar trivial invocation) succeeds with
 * exit 0. We use `which`-style PATH lookup via spawnSync; cross-platform
 * because we don't shell out — Node resolves the binary itself.
 */
function hasBinary(cmd: string, probeArgs: string[] = ['--version']): boolean {
  try {
    const res = spawnSync(cmd, probeArgs, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Require a usable `claude` CLI on PATH. The smoke scripts that drive
 * `runRequirement` always spawn a real `claude -p` child process via
 * `LocalSandboxProvider`; without the binary they fail in opaque ways.
 *
 * We probe with `claude --version`. We do NOT check for a valid login
 * session here — that would require either spawning `claude` interactively
 * or hitting the API; if a script later fails because the CLI is logged
 * out, that's an honest failure (not a credential-availability gap).
 */
export function requireClaude(): void {
  if (!hasBinary('claude')) {
    skip('claude CLI not found on PATH (install Claude Code to run this smoke)');
  }
}

/**
 * Require a `git` binary. All smoke scripts shell out to git for fixture
 * setup, even the in-memory ones.
 */
export function requireGit(): void {
  if (!hasBinary('git', ['--version'])) {
    skip('git not found on PATH');
  }
}

/**
 * Require `gh` CLI installed AND authenticated. `gh auth status` exits 0
 * iff there's at least one logged-in host; we additionally require it to
 * be `github.com` (the smoke repo lives there).
 */
export function requireGhAuth(): void {
  if (!hasBinary('gh', ['--version'])) {
    skip('gh CLI not found on PATH');
  }
  const res = spawnSync('gh', ['auth', 'status'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    skip('gh CLI is installed but not authenticated (run `gh auth login`)');
  }
  // `gh auth status` writes to stderr by convention; check both streams.
  const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!/github\.com/i.test(combined)) {
    skip('gh CLI authenticated but no github.com host found in `gh auth status`');
  }
}

/**
 * Require SSH push capability for a given repo. We use `git ls-remote`
 * because it's the cheapest read-side check that exercises the same
 * SSH key path push will use. If the host has no SSH key registered
 * with GitHub, this fails fast with exit != 0.
 *
 * Pass the SSH URL (e.g. `git@github.com:owner/repo.git`).
 */
export function requireGitRemoteAccess(sshUrl: string): void {
  const res = spawnSync('git', ['ls-remote', sshUrl, 'HEAD'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 30_000,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    skip(
      `cannot reach ${sshUrl} via SSH (git ls-remote failed: ${
        (res.stderr ?? '').trim().slice(0, 200) || 'no stderr'
      })`,
    );
  }
}
