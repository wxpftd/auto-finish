import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, HttpApi } from './client.js';
import type { Project, Requirement, StageExecution } from './types.js';

interface MockResponse {
  status: number;
  body?: unknown;
  textBody?: string;
}

function makeFetch(responses: Map<string, MockResponse | (() => MockResponse)>): typeof globalThis.fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const entry = responses.get(url);
    if (entry === undefined) {
      throw new Error(`unexpected fetch URL in test: ${url}`);
    }
    const resolved = typeof entry === 'function' ? entry() : entry;
    const body =
      resolved.textBody !== undefined
        ? resolved.textBody
        : JSON.stringify(resolved.body ?? {});
    return new Response(body, {
      status: resolved.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpApi.listProjects', () => {
  it('calls the right URL and unwraps the envelope', async () => {
    const sample: Project[] = [
      {
        id: 'p1',
        name: 'demo',
        description: null,
        default_pipeline_id: null,
        sandbox_config_json: {},
        claude_config_json: { credentials_source: 'host_mount' },
        created_at: 1,
        updated_at: 2,
      },
    ];
    const fetchSpy = vi.fn(
      makeFetch(
        new Map([
          [
            'http://example.test/api/projects',
            { status: 200, body: { projects: sample } },
          ],
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const api = new HttpApi({ baseUrl: 'http://example.test' });
    const out = await api.listProjects();
    expect(out).toEqual(sample);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe('http://example.test/api/projects');
  });

  it('respects a custom baseUrl', async () => {
    const fetchSpy = vi.fn(
      makeFetch(
        new Map([
          ['http://other.test/api/projects', { status: 200, body: { projects: [] } }],
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const api = new HttpApi({ baseUrl: 'http://other.test' });
    const out = await api.listProjects();
    expect(out).toEqual([]);
    expect(api.getBaseUrl()).toBe('http://other.test');
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchSpy = vi.fn(
      makeFetch(
        new Map([
          ['http://example.test/api/projects', { status: 200, body: { projects: [] } }],
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const api = new HttpApi({ baseUrl: 'http://example.test/' });
    await api.listProjects();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://example.test/api/projects');
  });

  it('throws ApiError with status 404 on not-found', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(
        new Map([
          [
            'http://example.test/api/projects',
            { status: 404, body: { error: 'not_found', message: 'gone' } },
          ],
        ]),
      ),
    );
    const api = new HttpApi({ baseUrl: 'http://example.test' });
    await expect(api.listProjects()).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
    await expect(api.listProjects()).rejects.toBeInstanceOf(ApiError);
  });

  it('wraps a network error as ApiError with status 0', async () => {
    const failingFetch: typeof globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    vi.stubGlobal('fetch', failingFetch);

    const api = new HttpApi({ baseUrl: 'http://example.test' });
    await expect(api.listProjects()).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
    });
  });
});

describe('HttpApi.listRequirements', () => {
  it('encodes filters into query string', async () => {
    const sample: Requirement[] = [];
    const fetchSpy = vi.fn(
      makeFetch(
        new Map([
          [
            'http://example.test/api/requirements?project_id=p1&status=running',
            { status: 200, body: { requirements: sample } },
          ],
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const api = new HttpApi({ baseUrl: 'http://example.test' });
    const out = await api.listRequirements({ project_id: 'p1', status: 'running' });
    expect(out).toEqual(sample);
  });

  it('omits the query string when no filters are supplied', async () => {
    const fetchSpy = vi.fn(
      makeFetch(
        new Map([
          ['http://example.test/api/requirements', { status: 200, body: { requirements: [] } }],
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const api = new HttpApi({ baseUrl: 'http://example.test' });
    await api.listRequirements();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://example.test/api/requirements');
  });
});

describe('HttpApi.listGates', () => {
  it('hits /api/gates/pending and returns stage_executions', async () => {
    const sample: StageExecution[] = [
      {
        id: 'se-1',
        run_id: 'r-1',
        stage_name: 'design',
        status: 'awaiting_gate',
        claude_subprocess_pid: null,
        claude_session_id: null,
        started_at: 1,
        finished_at: null,
        events_json: [],
      },
    ];
    vi.stubGlobal(
      'fetch',
      makeFetch(
        new Map([
          [
            'http://example.test/api/gates/pending',
            { status: 200, body: { stage_executions: sample } },
          ],
        ]),
      ),
    );
    const api = new HttpApi({ baseUrl: 'http://example.test' });
    const out = await api.listGates();
    expect(out).toEqual(sample);
  });
});

describe('HttpApi.decideGate', () => {
  it('POSTs the wire-format decision body', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetcher: typeof globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured.url = typeof url === 'string' ? url : (url as URL).toString();
      captured.init = init;
      return new Response(
        JSON.stringify({
          stage: { id: 'se-1', status: 'gate_approved' },
          decision: { decision: 'approved' },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;
    vi.stubGlobal('fetch', fetcher);

    const api = new HttpApi({ baseUrl: 'http://example.test' });
    const result = await api.decideGate('se-1', 'approved', 'lgtm', 'me@example.com');
    expect(captured.url).toBe('http://example.test/api/gates/se-1/decide');
    expect(captured.init?.method).toBe('POST');
    const body = JSON.parse(String(captured.init?.body));
    expect(body).toEqual({
      decision: 'approved',
      feedback: 'lgtm',
      decided_by: 'me@example.com',
    });
    expect(result.stage).toMatchObject({ id: 'se-1' });
  });
});

describe('HttpApi.getRepos', () => {
  it('hits /api/projects/:id/repos', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch(
        new Map([
          [
            'http://example.test/api/projects/abc/repos',
            { status: 200, body: { repos: [] } },
          ],
        ]),
      ),
    );
    const api = new HttpApi({ baseUrl: 'http://example.test' });
    const out = await api.getRepos('abc');
    expect(out).toEqual([]);
  });
});
