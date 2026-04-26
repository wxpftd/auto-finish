/**
 * Typed API client for the orchestrator.
 *
 * Two implementations are provided:
 *  - HttpApi:  default — talks to the orchestrator over fetch.
 *  - MockApi:  in-memory fixtures with artificial latency, used by Storybook,
 *              tests, and `?mock=1` designer mode.
 *
 * Components and `+page.ts` files import the singleton `api` from this
 * module — DO NOT instantiate a new client inline.
 */

import { env as publicEnv } from '$env/dynamic/public';
import {
  mockArtifacts,
  mockGateExecutions,
  mockPipeline,
  mockProjects,
  mockPullRequests,
  mockRepos,
  mockRequirements,
  mockRuns,
} from './mock-data.js';
import type {
  Artifact,
  GateDecisionValue,
  Project,
  ProjectDetail,
  PullRequest,
  Repo,
  Requirement,
  RequirementDetail,
  RequirementListFilters,
  StageExecution,
  PipelineRun,
} from './types.js';

// ---------------------------------------------------------------------------
// Shared error type
// ---------------------------------------------------------------------------

/**
 * Thrown by HttpApi for non-2xx responses or transport failures. `status === 0`
 * is used for client-side network / parse errors that didn't reach the server.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly url: string;
  public readonly body: unknown;

  constructor(message: string, opts: { status: number; url: string; body?: unknown }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.url = opts.url;
    this.body = opts.body;
  }
}

// ---------------------------------------------------------------------------
// API contract
// ---------------------------------------------------------------------------

export interface Api {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<ProjectDetail>;
  getRepos(projectId: string): Promise<Repo[]>;
  listRequirements(filters?: RequirementListFilters): Promise<Requirement[]>;
  getRequirement(id: string): Promise<RequirementDetail>;
  /** Pending-gate stage executions (rows with status === 'awaiting_gate'). */
  listGates(): Promise<StageExecution[]>;
  getGate(stageExecutionId: string): Promise<StageExecution>;
  /** Decide a gate. `decision` is the wire format (`approved` | `rejected`). */
  decideGate(
    stageExecutionId: string,
    decision: GateDecisionValue,
    feedback?: string,
    decidedBy?: string,
  ): Promise<{ stage: StageExecution; decision: unknown }>;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

export interface HttpApiOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Resolve the default API base URL.
 *
 * Reads `PUBLIC_API_BASE_URL` from SvelteKit's runtime-public env (resolved at
 * request time on the server and at module-load on the client). Falls back to
 * an empty string (same-origin) so production deployments can front the
 * dashboard and orchestrator behind one origin.
 *
 * Tests / non-SvelteKit consumers can inject a value via the constructor's
 * `baseUrl` argument and avoid this helper entirely.
 */
function resolveDefaultBaseUrl(): string {
  const fromEnv = publicEnv?.PUBLIC_API_BASE_URL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return '';
}

export class HttpApi implements Api {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: HttpApiOptions = {}) {
    const root = options.baseUrl ?? resolveDefaultBaseUrl();
    this.baseUrl = root.replace(/\/$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Returns the configured base URL (without `/api`). Used by tests / WS. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Issue a JSON request and unwrap a single envelope key (the orchestrator
   * wraps every response, e.g. `{ projects: [...] }`).
   */
  private async req<T>(
    path: string,
    envelopeKey: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    let res: Response;
    try {
      res = await this.fetcher(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError(`network error: ${reason}`, { status: 0, url });
    }

    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      // Tolerate empty bodies / non-JSON; we still surface non-2xx below.
    }

    if (!res.ok) {
      const message =
        (body as { message?: string } | undefined)?.message ??
        `${init?.method ?? 'GET'} ${url} failed: ${res.status}`;
      throw new ApiError(message, { status: res.status, url, body });
    }

    if (body === undefined || body === null || typeof body !== 'object') {
      throw new ApiError(
        `unexpected response body for ${url}`,
        { status: res.status, url, body },
      );
    }
    const wrapped = body as Record<string, unknown>;
    if (!(envelopeKey in wrapped)) {
      throw new ApiError(
        `missing envelope key "${envelopeKey}" in response from ${url}`,
        { status: res.status, url, body },
      );
    }
    return wrapped[envelopeKey] as T;
  }

  listProjects(): Promise<Project[]> {
    return this.req<Project[]>('/projects', 'projects');
  }

  async getProject(id: string): Promise<ProjectDetail> {
    const enc = encodeURIComponent(id);
    const [project, repos, requirements] = await Promise.all([
      this.req<Project>(`/projects/${enc}`, 'project'),
      this.req<Repo[]>(`/projects/${enc}/repos`, 'repos'),
      this.req<Requirement[]>(`/requirements?project_id=${enc}`, 'requirements'),
    ]);
    return { project, repos, requirements };
  }

  getRepos(projectId: string): Promise<Repo[]> {
    return this.req<Repo[]>(
      `/projects/${encodeURIComponent(projectId)}/repos`,
      'repos',
    );
  }

  listRequirements(filters: RequirementListFilters = {}): Promise<Requirement[]> {
    const qs = new URLSearchParams();
    if (filters.project_id) qs.set('project_id', filters.project_id);
    if (filters.status) qs.set('status', filters.status);
    const tail = qs.toString() ? `?${qs.toString()}` : '';
    return this.req<Requirement[]>(`/requirements${tail}`, 'requirements');
  }

  async getRequirement(id: string): Promise<RequirementDetail> {
    const enc = encodeURIComponent(id);
    const requirement = await this.req<Requirement>(
      `/requirements/${enc}`,
      'requirement',
    );

    // Pull the project so the detail page can render the project header.
    const project = await this.req<Project>(
      `/projects/${encodeURIComponent(requirement.project_id)}`,
      'project',
    );

    // Latest run by started_at; the requirements/:id/runs route returns ALL.
    const runs = await this.req<PipelineRun[]>(
      `/requirements/${enc}/runs`,
      'runs',
    );
    const sorted = [...runs].sort((a, b) => b.started_at - a.started_at);
    const latest = sorted[0];

    let run: PipelineRun | null = null;
    let pull_requests: PullRequest[] = [];

    if (latest) {
      // Re-fetch via /api/runs/:id so the response includes the joined
      // stage_executions and `per_repo_branches` projection.
      const detailedRun = await this.req<PipelineRun>(
        `/runs/${encodeURIComponent(latest.id)}`,
        'run',
      );
      run = detailedRun;

      try {
        pull_requests = await this.req<PullRequest[]>(
          `/runs/${encodeURIComponent(latest.id)}/prs`,
          'pull_requests',
        );
      } catch (err) {
        // PR list is optional; let the rest of the page render.
        if (!(err instanceof ApiError) || err.status !== 404) {
          throw err;
        }
      }
    }

    // Pipeline definition: the orchestrator persists a snapshot on the run.
    const pipeline = run?.pipeline_snapshot_json ?? {
      id: requirement.pipeline_id,
      name: 'pipeline',
      version: '1',
      stages: [],
    };

    // No artifacts list endpoint exists yet; keep an empty array so the UI
    // gracefully degrades (preview blocks already guard `artifacts.length > 0`).
    const artifacts: Artifact[] = [];

    return {
      requirement,
      project,
      pipeline,
      run,
      artifacts,
      pull_requests,
    };
  }

  listGates(): Promise<StageExecution[]> {
    return this.req<StageExecution[]>('/gates/pending', 'stage_executions');
  }

  /**
   * Look up a single pending gate by stage_execution_id. The orchestrator
   * doesn't expose a single-gate endpoint; we filter the pending list.
   */
  async getGate(stageExecutionId: string): Promise<StageExecution> {
    const list = await this.listGates();
    const found = list.find((s) => s.id === stageExecutionId);
    if (!found) {
      throw new ApiError(`gate not found: ${stageExecutionId}`, {
        status: 404,
        url: `${this.baseUrl}/api/gates/pending`,
      });
    }
    return found;
  }

  async decideGate(
    stageExecutionId: string,
    decision: GateDecisionValue,
    feedback?: string,
    decidedBy: string = 'dashboard-user@auto-finish.local',
  ): Promise<{ stage: StageExecution; decision: unknown }> {
    const enc = encodeURIComponent(stageExecutionId);
    const url = `${this.baseUrl}/api/gates/${enc}/decide`;
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, feedback, decided_by: decidedBy }),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError(`network error: ${reason}`, { status: 0, url });
    }
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const message =
        (body as { message?: string } | undefined)?.message ??
        `POST ${url} failed: ${res.status}`;
      throw new ApiError(message, { status: res.status, url, body });
    }
    return body as { stage: StageExecution; decision: unknown };
  }
}

// ---------------------------------------------------------------------------
// Mock implementation (kept for tests / Storybook / `?mock=1` designer mode)
// ---------------------------------------------------------------------------

export interface MockApiOptions {
  /** Simulated network delay per call (ms). */
  delayMs?: number;
}

export class MockApi implements Api {
  private readonly delayMs: number;
  private readonly stages: StageExecution[];

  constructor(options: MockApiOptions = {}) {
    this.delayMs = options.delayMs ?? 50;
    this.stages = mockGateExecutions.map((s) => ({ ...s }));
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async listProjects(): Promise<Project[]> {
    await this.wait();
    return mockProjects.map((p) => ({ ...p }));
  }

  async getProject(id: string): Promise<ProjectDetail> {
    await this.wait();
    const project = mockProjects.find((p) => p.id === id);
    if (!project) {
      throw new ApiError(`project not found: ${id}`, {
        status: 404,
        url: `mock://projects/${id}`,
      });
    }
    return {
      project: { ...project },
      repos: mockRepos.filter((r) => r.project_id === id).map((r) => ({ ...r })),
      requirements: mockRequirements
        .filter((r) => r.project_id === id)
        .map((r) => ({ ...r })),
    };
  }

  async getRepos(projectId: string): Promise<Repo[]> {
    await this.wait();
    return mockRepos.filter((r) => r.project_id === projectId).map((r) => ({ ...r }));
  }

  async listRequirements(
    filters: RequirementListFilters = {},
  ): Promise<Requirement[]> {
    await this.wait();
    return mockRequirements
      .filter((r) => !filters.project_id || r.project_id === filters.project_id)
      .filter((r) => !filters.status || r.status === filters.status)
      .map((r) => ({ ...r }));
  }

  async getRequirement(id: string): Promise<RequirementDetail> {
    await this.wait();
    const requirement = mockRequirements.find((r) => r.id === id);
    if (!requirement) {
      throw new ApiError(`requirement not found: ${id}`, {
        status: 404,
        url: `mock://requirements/${id}`,
      });
    }
    const project = mockProjects.find((p) => p.id === requirement.project_id);
    if (!project) {
      throw new ApiError(`project for requirement not found: ${id}`, {
        status: 500,
        url: `mock://requirements/${id}`,
      });
    }
    const run = mockRuns.find((r) => r.requirement_id === id) ?? null;

    const stageIds = new Set<string>(
      run?.stage_executions?.map((se) => se.id) ?? [],
    );
    const artifacts: Artifact[] = mockArtifacts
      .filter((a) => stageIds.has(a.stage_execution_id))
      .map((a) => ({ ...a }));
    const pull_requests: PullRequest[] = mockPullRequests
      .filter((pr) => pr.run_id === run?.id)
      .map((pr) => ({ ...pr }));

    return {
      requirement: { ...requirement },
      project: { ...project },
      pipeline: mockPipeline,
      run: run ? { ...run, stage_executions: run.stage_executions ? [...run.stage_executions] : [] } : null,
      artifacts,
      pull_requests,
    };
  }

  async listGates(): Promise<StageExecution[]> {
    await this.wait();
    return this.stages.map((s) => ({ ...s }));
  }

  async getGate(id: string): Promise<StageExecution> {
    await this.wait();
    const stage = this.stages.find((s) => s.id === id);
    if (!stage) {
      throw new ApiError(`gate not found: ${id}`, {
        status: 404,
        url: `mock://gates/${id}`,
      });
    }
    return { ...stage };
  }

  async decideGate(
    id: string,
    decision: GateDecisionValue,
    feedback?: string,
    decidedBy: string = 'mock-user@auto-finish.local',
  ): Promise<{ stage: StageExecution; decision: unknown }> {
    await this.wait();
    const stage = this.stages.find((s) => s.id === id);
    if (!stage) {
      throw new ApiError(`gate not found: ${id}`, {
        status: 404,
        url: `mock://gates/${id}/decide`,
      });
    }
    stage.status = decision === 'approved' ? 'gate_approved' : 'gate_rejected';
    stage.finished_at = Date.now();
    return {
      stage: { ...stage },
      decision: {
        id: `mock-decision-${id}`,
        stage_execution_id: id,
        decision,
        feedback: feedback ?? null,
        decided_by: decidedBy,
        decided_at: Date.now(),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton — HttpApi by default, MockApi available behind ?mock=1.
// ---------------------------------------------------------------------------

function pickDefaultApi(): Api {
  if (typeof globalThis === 'undefined') return new HttpApi();
  // SvelteKit runs +page.ts on the server too; window-only check.
  if (typeof window === 'undefined') return new HttpApi();
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mock') === '1') return new MockApi();
  } catch {
    /* ignore */
  }
  return new HttpApi();
}

export const api: Api = pickDefaultApi();
