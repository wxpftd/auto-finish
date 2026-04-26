/**
 * Tier 2 cold-restart fallback helpers (decision 4 in the plan).
 *
 * Pure module — no DB, no network, no event bus. The runner is the
 * orchestrator. This file owns:
 *
 *  1. `detectDepInstallFailure` — a conservative whitelist scan of stage
 *     events for the kernel/permission signatures that mean "the agent
 *     tried to write deps onto a read-only or shared layer and failed".
 *  2. `snapshotArtifacts` / `restoreArtifacts` — capture and replay the
 *     `.auto-finish/artifacts/` tree across a sandbox destroy → recreate
 *     so already-completed stages don't have to rerun.
 *
 * StageEvent vs ClaudeStageEvent
 * -------------------------------
 * The detector is intentionally typed against the persisted `StageEvent`
 * shape (`{ type: string; ts: number; [k: string]: unknown }`) rather than
 * the richer `ClaudeStageEvent`. Two reasons:
 *  - Callers that already have events in hand (the runner's in-memory
 *    `outcome.events`) and callers that re-read from `events_json` can both
 *    use the same function without a cast.
 *  - The persisted shape is what we'd see on a crash-resume read; staying
 *    on that shape keeps the future resume path honest.
 * `event.type` corresponds to `ClaudeStageEvent.kind` — the persistence
 * layer renames the discriminant.
 *
 * Snapshot is in-memory rather than via the DB, because the orchestrator
 * does not yet persist artifacts to a backing store. The MVP trade-off
 * (in-memory == lost on orchestrator crash) is acceptable since
 * cold-restart is intra-run and crash-resumption is itself a Phase 2 item.
 */

import type { StageEvent } from '../db/schema.js';
import type { SandboxSession } from '../sandbox/interface.js';

/**
 * Whitelist of error signatures that indicate dep-install failed against a
 * read-only / shared layer (warm path). Conservative on purpose — false
 * positives trigger an unnecessary cold sandbox recreate; false negatives
 * fall back to the original on_failure policy.
 *
 * Patterns:
 *  - "Read-only file system" — kernel/EROFS message; appears on baked_image
 *    when something tries to write under a baked path.
 *  - "EACCES" plus a deps-cache directory — npm/pnpm/pip writing to the
 *    shared volume's mount point typically lands here.
 */
export const DEP_FAILURE_PATTERNS: readonly RegExp[] = [
  /Read-only file system/,
  /EACCES.*(?:node_modules|\.venv|\.m2|site-packages|\.cargo)/,
];

/**
 * Returns true if any event in `events` carries a stderr-like payload that
 * matches a `DEP_FAILURE_PATTERNS` signature. Scans:
 *   - `tool_result.content` (where bash / npm tool stderr lands).
 *   - `assistant_text.text` (in case claude paraphrases the error).
 *
 * Other event kinds are ignored. Empty input returns `false`.
 */
export function detectDepInstallFailure(events: StageEvent[]): boolean {
  if (events.length === 0) return false;

  for (const event of events) {
    const candidate = extractScannableText(event);
    if (candidate === null) continue;
    if (DEP_FAILURE_PATTERNS.some((re) => re.test(candidate))) {
      return true;
    }
  }
  return false;
}

/** Pull the text payload (if any) out of a StageEvent for pattern scanning. */
function extractScannableText(event: StageEvent): string | null {
  if (event.type === 'tool_result') {
    const content = (event as { content?: unknown }).content;
    return typeof content === 'string' ? content : null;
  }
  if (event.type === 'assistant_text') {
    const text = (event as { text?: unknown }).text;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

/**
 * Snapshot of stage artifact files captured from the failing sandbox before
 * destroy. The restore phase writes them back into the new sandbox at the
 * same path so already-completed stages don't have to rerun.
 */
export interface ArtifactSnapshot {
  path: string;
  bytes: Uint8Array;
}

const DEFAULT_ARTIFACTS_ROOT = '/workspace/.auto-finish/artifacts';

/**
 * Read every file under `artifactsRoot` (default `/workspace/.auto-finish/artifacts`)
 * from the given session. Used to capture prior-stage artifacts before
 * destroying the failed sandbox.
 *
 * Implementation note: SandboxSession exposes `readFile` but not directory
 * listing. We discover paths via a `find` shell command (POSIX-portable),
 * which works on every container image we boot. On a missing root, return
 * `[]` (no artifacts yet).
 *
 * Paths containing newlines are not supported (we use newline as the
 * separator). This is fine for our generated artifact tree, which uses
 * `<stage>/<artifact-name>.<ext>` naming.
 */
export async function snapshotArtifacts(
  session: SandboxSession,
  artifactsRoot: string = DEFAULT_ARTIFACTS_ROOT,
): Promise<ArtifactSnapshot[]> {
  // Probe for existence first. We use `[ -d ... ]` so a missing root yields
  // exit 1 cleanly rather than a `find: no such file` error.
  const existsProbe = await session.run([
    '/bin/sh',
    '-c',
    `[ -d "${artifactsRoot}" ] && echo present || echo absent`,
  ]);
  if (existsProbe.exit_code !== 0 || !existsProbe.stdout.includes('present')) {
    return [];
  }

  const listing = await session.run([
    '/bin/sh',
    '-c',
    `find "${artifactsRoot}" -type f -print`,
  ]);
  if (listing.exit_code !== 0) {
    // `find` failed for some reason — return empty rather than crashing the
    // whole cold-restart. The new sandbox will simply have a fresh
    // artifacts/ tree; downstream stages may need to redo prior work, but
    // that's strictly safer than aborting the run.
    return [];
  }

  const paths = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const snapshot: ArtifactSnapshot[] = [];
  for (const path of paths) {
    try {
      const bytes = await session.readFile(path);
      snapshot.push({ path, bytes });
    } catch {
      // File disappeared between listing and read — skip it. Conservative
      // on purpose; we don't want a transient FS race to kill the snapshot.
    }
  }
  return snapshot;
}

/**
 * Write each artifact back into the given session at its original path.
 * Order is the same as the snapshot's iteration order (i.e. `find` order).
 */
export async function restoreArtifacts(
  session: SandboxSession,
  snapshot: ArtifactSnapshot[],
): Promise<void> {
  for (const entry of snapshot) {
    await session.writeFile(entry.path, entry.bytes);
  }
}
