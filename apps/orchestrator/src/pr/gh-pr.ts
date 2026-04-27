/**
 * GitHub PR plumbing — wraps `gh pr create` / `gh pr view` / `gh pr edit`.
 *
 * We assume the sandbox already has the `gh` CLI installed and authenticated
 * (this is a documented prerequisite of the auto-finish runtime). All calls
 * use the argv form via SandboxSession.run, so PR titles, bodies, and slugs
 * travel safely regardless of their content — no shell interpolation anywhere.
 *
 * Idempotency: if `gh pr create` reports "already exists" for the head
 * branch, we fall back to `gh pr view --head <branch> --json url,number`
 * and return the existing PR. Any other failure surfaces as `PrCreateError`.
 */
import type { SandboxSession } from '../sandbox/interface.js';
import type { RepoSpec } from '../multi-repo/index.js';

export interface OpenPrInput {
  session: SandboxSession;
  repo: RepoSpec;
  branchName: string;
  /** e.g. 'main' (typically `repo.default_branch`). */
  baseBranch: string;
  title: string;
  body: string;
}

export interface OpenPrResult {
  pr_url: string;
  pr_number: number;
}

export class PrCreateError extends Error {
  override readonly name = 'PrCreateError';
  readonly stderr: string;
  readonly stdout: string;
  readonly exit_code: number;
  readonly slug: string;

  constructor(
    slug: string,
    message: string,
    exit_code: number,
    stderr: string,
    stdout: string,
  ) {
    super(message);
    this.slug = slug;
    this.exit_code = exit_code;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

export class UnknownGitHostError extends Error {
  override readonly name = 'UnknownGitHostError';
  readonly url: string;
  constructor(url: string) {
    super(`Unsupported git host (only github.com is supported): ${url}`);
    this.url = url;
  }
}

/**
 * Derive `owner/repo` from a git URL.
 *
 * Supported forms:
 *   - `git@github.com:owner/repo.git`
 *   - `git@github.com:owner/repo`
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *   - `ssh://git@github.com/owner/repo.git`
 *
 * Anything not on github.com → {@link UnknownGitHostError}.
 */
export function inferRepoSlug(git_url: string): string {
  const url = git_url.trim();

  // SCP-style: git@host:owner/repo[.git]
  const scp = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp !== null) {
    const host = scp[1];
    const path = scp[2];
    if (host !== 'github.com' || path === undefined || path === '') {
      throw new UnknownGitHostError(git_url);
    }
    return path;
  }

  // URL-style: https:// or ssh:// (or git://). Let URL handle parsing.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnknownGitHostError(git_url);
  }
  if (parsed.hostname !== 'github.com') {
    throw new UnknownGitHostError(git_url);
  }
  // pathname starts with '/'. Strip leading '/' and trailing '.git' / '/'.
  let p = parsed.pathname.replace(/^\/+/, '');
  p = p.replace(/\.git$/, '');
  p = p.replace(/\/+$/, '');
  if (p === '' || !p.includes('/')) {
    throw new UnknownGitHostError(git_url);
  }
  return p;
}

/**
 * `gh pr create` writes the PR URL on stdout, optionally with a trailing
 * newline. Pull the integer at the end of the URL path.
 */
function parsePrUrl(stdout: string): { pr_url: string; pr_number: number } {
  const lines = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const url = lines[lines.length - 1];
  if (url === undefined || url === '') {
    throw new Error(`gh pr create produced no URL on stdout: ${stdout}`);
  }
  const m = /\/pull\/(\d+)\/?$/.exec(url);
  if (m === null || m[1] === undefined) {
    throw new Error(`Could not parse PR number from URL: ${url}`);
  }
  return { pr_url: url, pr_number: Number.parseInt(m[1], 10) };
}

export async function openPullRequest(
  input: OpenPrInput,
): Promise<OpenPrResult> {
  const { session, repo, branchName, baseBranch, title, body } = input;
  const slug = inferRepoSlug(repo.git_url);

  const createRes = await session.run([
    'gh',
    'pr',
    'create',
    '--repo',
    slug,
    '--base',
    baseBranch,
    '--head',
    branchName,
    '--title',
    title,
    '--body',
    body,
  ]);

  if (createRes.exit_code === 0) {
    return parsePrUrl(createRes.stdout);
  }

  // Fallback: existing PR. gh's exact phrasing varies a bit ("a pull request
  // for branch X already exists" / "PR already exists"), so substring-match.
  if (/already exists/i.test(createRes.stderr)) {
    const viewRes = await session.run([
      'gh',
      'pr',
      'view',
      '--head',
      branchName,
      '--json',
      'url,number',
      '--repo',
      slug,
    ]);
    if (viewRes.exit_code !== 0) {
      throw new PrCreateError(
        slug,
        `gh pr view fallback failed for ${branchName}: ${viewRes.stderr || viewRes.stdout}`,
        viewRes.exit_code,
        viewRes.stderr,
        viewRes.stdout,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(viewRes.stdout);
    } catch (err) {
      throw new PrCreateError(
        slug,
        `gh pr view returned non-JSON: ${(err as Error).message}: ${viewRes.stdout}`,
        viewRes.exit_code,
        viewRes.stderr,
        viewRes.stdout,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { url?: unknown }).url !== 'string' ||
      typeof (parsed as { number?: unknown }).number !== 'number'
    ) {
      throw new PrCreateError(
        slug,
        `gh pr view returned unexpected JSON shape: ${viewRes.stdout}`,
        viewRes.exit_code,
        viewRes.stderr,
        viewRes.stdout,
      );
    }
    const obj = parsed as { url: string; number: number };
    return { pr_url: obj.url, pr_number: obj.number };
  }

  throw new PrCreateError(
    slug,
    `gh pr create failed (exit ${createRes.exit_code}) for ${slug}: ${
      createRes.stderr || createRes.stdout
    }`,
    createRes.exit_code,
    createRes.stderr,
    createRes.stdout,
  );
}

/**
 * Edit an existing PR's body. Used by Phase 2 of the cross-link flow,
 * after every sibling PR has been created and we know its URL.
 *
 * Uses `gh api -X PATCH /repos/<slug>/pulls/<n> -f body=<...>` (REST) instead
 * of `gh pr edit`. Reason: as of 2024-05 GitHub sunset Projects (classic),
 * and `gh pr edit` internally queries `repository.pullRequest.projectCards`
 * via GraphQL — the deprecation has hardened into a 4xx that breaks any
 * automated edit flow. The REST PATCH endpoint doesn't touch projectCards
 * and only updates the fields explicitly passed.
 */
export async function editPullRequestBody(args: {
  session: SandboxSession;
  repo: RepoSpec;
  prNumber: number;
  body: string;
}): Promise<void> {
  const { session, repo, prNumber, body } = args;
  const slug = inferRepoSlug(repo.git_url);
  const res = await session.run([
    'gh',
    'api',
    '-X',
    'PATCH',
    `/repos/${slug}/pulls/${prNumber}`,
    '-f',
    `body=${body}`,
  ]);
  if (res.exit_code !== 0) {
    throw new PrCreateError(
      slug,
      `gh api PATCH /repos/${slug}/pulls/${prNumber} failed: ${res.stderr || res.stdout}`,
      res.exit_code,
      res.stderr,
      res.stdout,
    );
  }
}
