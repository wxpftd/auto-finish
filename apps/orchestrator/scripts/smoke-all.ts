/**
 * Smoke harness — runs every smoke script sequentially and prints a summary.
 *
 * Behaviour:
 *   - Spawns each smoke script as a child `tsx scripts/<name>.ts` process.
 *   - Tees stdout+stderr to per-run log files under
 *     `<repo-root>/.smoke-logs/<ISO-timestamp>/<name>.log`. The directory
 *     is created lazily; the path is git-ignored at the repo root.
 *   - Distinguishes three outcomes per script:
 *       PASS    : exit 0 and stdout did NOT begin a line with `SKIPPED:`
 *       SKIPPED : exit 0 AND stdout contained a line starting with `SKIPPED:`
 *                 (the credential-presence guard short-circuited cleanly)
 *       FAIL    : non-zero exit OR child error
 *   - Fails fast on first FAIL (does NOT continue), but SKIPPED never trips
 *     fail-fast — that's the whole point of the guards.
 *   - At the end, prints a one-line summary in the form
 *       "✓ smoke-runner | ⊘ smoke-github | ✗ smoke-multistage"
 *     and exits 0 on all-clean / 1 on any FAIL.
 *
 * Why no shell, no extra deps:
 *   The task constraints require cross-platform behaviour with no new deps.
 *   `child_process.spawn` + `node:fs` + `node:path` cover all of this.
 *
 * Why list smoke scripts here (not glob the dir):
 *   We want a deterministic order for fail-fast semantics, AND `local-provider.ts`
 *   in the same directory is a LIBRARY (no main()) — globbing would try to
 *   "run" it. Explicit list = no surprises.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The smoke scripts to run, in order. `local-provider.ts` is intentionally
 * NOT here — it's a SandboxProvider implementation imported by the others,
 * not a standalone runnable.
 *
 * Order: cheapest / most foundational first, so a real bug surfaces in the
 * shortest possible loop.
 */
const SCRIPTS: ReadonlyArray<{ name: string; file: string }> = [
  { name: 'smoke-runner', file: 'smoke-runner.ts' },
  { name: 'smoke-gate', file: 'smoke-gate.ts' },
  { name: 'smoke-multistage', file: 'smoke-multistage.ts' },
  { name: 'smoke-github', file: 'smoke-github.ts' },
];

/** Per-script wallclock cap. The 4-stage script can legitimately take >5min
 *  with a real Claude subscription; smoke-github similarly does PR round-trip.
 *  Keep this generous — CI gates the whole job at workflow level. */
const SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** apps/orchestrator (the cwd we want for `tsx scripts/X.ts`). */
const ORCHESTRATOR_DIR = resolve(__dirname, '..');
/** Repo root — three up from this file: orchestrator/scripts/_/../../.. */
const REPO_ROOT = resolve(ORCHESTRATOR_DIR, '..', '..');

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

type Outcome = 'PASS' | 'SKIPPED' | 'FAIL';

interface RunResult {
  name: string;
  outcome: Outcome;
  exitCode: number;
  durationMs: number;
  logPath: string;
  /** Reason text extracted from `SKIPPED:` line (if any) or short failure
   *  excerpt — used in the summary. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** ISO timestamp safe for filesystem paths (no `:` — Windows-hostile). */
function tsForPath(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

/**
 * Spawn one smoke script, tee its output to a log, classify the result.
 * Never throws — failures become RunResult with outcome=FAIL.
 */
async function runOne(
  script: { name: string; file: string },
  logDir: string,
): Promise<RunResult> {
  const logPath = join(logDir, `${script.name}.log`);
  const logStream = createWriteStream(logPath, { flags: 'w' });

  const start = Date.now();
  // Buffer captured stdout so we can scan for the `SKIPPED:` marker after
  // the child exits. We deliberately do NOT scan stderr — the convention is
  // that `SKIPPED:` is a stdout signal from our own guards.
  let stdoutBuf = '';

  // Resolve the orchestrator-local tsx binary. We deliberately don't rely
  // on PATH (CI shells may not have node_modules/.bin pre-pended). Falling
  // back to `tsx` on PATH only as a last resort.
  const localTsx = join(
    ORCHESTRATOR_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  const tsxBin = existsSync(localTsx) ? localTsx : 'tsx';

  const child = spawn(tsxBin, [`scripts/${script.file}`], {
    cwd: ORCHESTRATOR_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  // Tee stdout: log file + buffer for SKIPPED detection.
  child.stdout.on('data', (b: Buffer) => {
    const s = b.toString('utf8');
    stdoutBuf += s;
    logStream.write(b);
  });
  child.stderr.on('data', (b: Buffer) => {
    logStream.write(b);
  });

  // Watchdog timer — kill if it exceeds the per-script cap.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, SCRIPT_TIMEOUT_MS);

  const exitCode = await new Promise<number>((resolveExit) => {
    child.on('error', (err) => {
      // ENOENT etc — treat as failure with code 127.
      logStream.write(`\n[smoke-all] spawn error: ${err.message}\n`);
      resolveExit(127);
    });
    child.on('close', (code) => {
      resolveExit(code ?? -1);
    });
  });
  clearTimeout(timer);
  await new Promise<void>((res) => logStream.end(res));

  const durationMs = Date.now() - start;

  if (timedOut) {
    return {
      name: script.name,
      outcome: 'FAIL',
      exitCode,
      durationMs,
      logPath,
      reason: `timed out after ${SCRIPT_TIMEOUT_MS}ms`,
    };
  }

  // Look for `SKIPPED:` at the start of any stdout line.
  const skippedMatch = stdoutBuf.match(/^SKIPPED:\s*(.+)$/m);
  if (exitCode === 0 && skippedMatch) {
    return {
      name: script.name,
      outcome: 'SKIPPED',
      exitCode,
      durationMs,
      logPath,
      reason: skippedMatch[1]!.trim(),
    };
  }
  if (exitCode === 0) {
    return {
      name: script.name,
      outcome: 'PASS',
      exitCode,
      durationMs,
      logPath,
      reason: null,
    };
  }
  return {
    name: script.name,
    outcome: 'FAIL',
    exitCode,
    durationMs,
    logPath,
    reason: `exit ${exitCode}`,
  };
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

const GLYPH: Record<Outcome, string> = {
  PASS: '✓', // ✓
  SKIPPED: '⊘', // ⊘
  FAIL: '✗', // ✗
};

function fmtSummary(results: RunResult[], notRun: string[]): string {
  const parts = results.map((r) => `${GLYPH[r.outcome]} ${r.name}`);
  for (const n of notRun) {
    parts.push(`… ${n} (not run)`);
  }
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const stamp = tsForPath();
  const logDir = join(REPO_ROOT, '.smoke-logs', stamp);
  await mkdir(logDir, { recursive: true });

  // eslint-disable-next-line no-console
  console.log(`[smoke-all] logs: ${logDir}`);
  // eslint-disable-next-line no-console
  console.log(
    `[smoke-all] running ${SCRIPTS.length} script(s): ${SCRIPTS.map((s) => s.name).join(', ')}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    '[smoke-all] note: SKIPPED is OK in CI without credentials (claude / gh / ssh).',
  );

  const results: RunResult[] = [];
  const remaining: string[] = [];
  let firstFailIdx = -1;

  for (let i = 0; i < SCRIPTS.length; i++) {
    const s = SCRIPTS[i]!;
    const banner = `[smoke-all] [${i + 1}/${SCRIPTS.length}] ${s.name} …`;
    // eslint-disable-next-line no-console
    console.log(banner);

    const result = await runOne(s, logDir);
    results.push(result);

    const tag = `${GLYPH[result.outcome]} ${result.outcome}`;
    const reason = result.reason ? ` (${result.reason})` : '';
    // eslint-disable-next-line no-console
    console.log(
      `[smoke-all]     ${tag} ${s.name} in ${result.durationMs}ms${reason}`,
    );
    // eslint-disable-next-line no-console
    console.log(`[smoke-all]     log: ${result.logPath}`);

    if (result.outcome === 'FAIL') {
      firstFailIdx = i;
      // Record what we never ran for the summary.
      for (let j = i + 1; j < SCRIPTS.length; j++) {
        remaining.push(SCRIPTS[j]!.name);
      }
      break;
    }
  }

  // Persist a small JSON summary alongside the logs for CI artifact upload.
  const summaryJson = {
    started_at: new Date(Date.parse(stamp + 'Z') || Date.now()).toISOString(),
    finished_at: new Date().toISOString(),
    scripts: results.map((r) => ({
      name: r.name,
      outcome: r.outcome,
      exit_code: r.exitCode,
      duration_ms: r.durationMs,
      log: r.logPath,
      reason: r.reason,
    })),
    not_run: remaining,
  };
  await writeFile(
    join(logDir, 'summary.json'),
    JSON.stringify(summaryJson, null, 2) + '\n',
    'utf8',
  );

  // eslint-disable-next-line no-console
  console.log('\n[smoke-all] ========== SUMMARY ==========');
  // eslint-disable-next-line no-console
  console.log(`[smoke-all] ${fmtSummary(results, remaining)}`);

  for (const r of results) {
    if (r.outcome === 'FAIL') {
      // eslint-disable-next-line no-console
      console.log(`[smoke-all] FAILED log: ${r.logPath}`);
    }
  }

  if (firstFailIdx >= 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke-all] FATAL harness error:', err);
  process.exitCode = 1;
});
