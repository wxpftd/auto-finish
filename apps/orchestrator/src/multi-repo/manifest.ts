/**
 * Persist a manifest of cloned repos inside the sandbox so downstream stages
 * (and Claude Code via system prompt injection) can discover the topology
 * without having to re-walk `/workspace/`.
 *
 * The manifest only records repos that were cloned successfully — failed
 * clones are signalled separately via {@link CloneReport.failed}.
 */
import type { SandboxSession } from '../sandbox/interface.js';
import type { CloneReport } from './clone.js';

export interface RepoManifestEntry {
  id: string;
  name: string;
  working_dir: string;
  head_sha: string;
}

export interface RepoManifest {
  requirement_id: string;
  repos: RepoManifestEntry[];
  /** ISO8601 timestamp generated at write time. */
  created_at: string;
}

export interface WriteManifestArgs {
  session: SandboxSession;
  requirementId: string;
  cloneReport: CloneReport;
  /** Defaults to '/workspace/.auto-finish/manifest.json'. */
  manifestPath?: string;
  /**
   * Optional injection point for the timestamp — primarily so tests can
   * assert a stable `created_at`. Defaults to `new Date().toISOString()`.
   */
  now?: () => string;
  /**
   * Optional override resolving repo names. cloneReport doesn't carry the
   * `name` field directly (only the id + working_dir + sha), so callers
   * supply a lookup; defaults to deriving the name from the working_dir
   * basename, which matches the convention `/workspace/<name>`.
   */
  resolveName?: (entry: { repo_id: string; working_dir: string }) => string;
}

const DEFAULT_PATH = '/workspace/.auto-finish/manifest.json';

export async function writeManifest(
  args: WriteManifestArgs,
): Promise<RepoManifest> {
  const {
    session,
    requirementId,
    cloneReport,
    manifestPath = DEFAULT_PATH,
    now = () => new Date().toISOString(),
    resolveName = defaultResolveName,
  } = args;

  const repos: RepoManifestEntry[] = cloneReport.cloned.map((c) => ({
    id: c.repo_id,
    name: resolveName({ repo_id: c.repo_id, working_dir: c.working_dir }),
    working_dir: c.working_dir,
    head_sha: c.head_sha,
  }));

  const manifest: RepoManifest = {
    requirement_id: requirementId,
    repos,
    created_at: now(),
  };

  const json = JSON.stringify(manifest, null, 2);
  // SandboxSession.writeFile takes Uint8Array, not string.
  const bytes = new TextEncoder().encode(json);
  await session.writeFile(manifestPath, bytes);

  return manifest;
}

/** `/workspace/frontend` → `frontend`. */
function defaultResolveName(entry: { working_dir: string }): string {
  const wd = entry.working_dir;
  const idx = wd.lastIndexOf('/');
  if (idx === -1 || idx === wd.length - 1) return wd;
  return wd.slice(idx + 1);
}
