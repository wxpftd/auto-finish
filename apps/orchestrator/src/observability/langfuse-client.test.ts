import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { PipelineEvent } from '../pipeline/index.js';
import type { ClaudeStageEvent } from '../claude/stage-event.js';
import type { LangfuseConfig } from './config.js';

// -----------------------------------------------------------------------------
// Mock: capture every Langfuse SDK call for assertion. The mock records
// (instance, method, args) tuples on shared arrays the tests can inspect.
// -----------------------------------------------------------------------------

interface MockSpan {
  end: Mock;
  update: Mock;
  event: Mock;
}
interface MockTrace {
  span: Mock;
  event: Mock;
  update: Mock;
}
interface MockLangfuseInstance {
  trace: Mock;
  shutdownAsync: Mock;
}

const mockState: {
  constructorCalls: unknown[][];
  instances: MockLangfuseInstance[];
  traces: MockTrace[];
  spans: MockSpan[];
  ctorThrows: boolean;
  traceThrows: boolean;
  spanThrows: boolean;
  shutdownThrows: boolean;
  spanEndThrows: boolean;
  spanUpdateThrows: boolean;
  spanEventThrows: boolean;
  traceEventThrows: boolean;
  traceUpdateThrows: boolean;
} = {
  constructorCalls: [],
  instances: [],
  traces: [],
  spans: [],
  ctorThrows: false,
  traceThrows: false,
  spanThrows: false,
  shutdownThrows: false,
  spanEndThrows: false,
  spanUpdateThrows: false,
  spanEventThrows: false,
  traceEventThrows: false,
  traceUpdateThrows: false,
};

function makeSpan(): MockSpan {
  const span: MockSpan = {
    end: vi.fn(() => {
      if (mockState.spanEndThrows) throw new Error('mock span.end fail');
      return span;
    }),
    update: vi.fn(() => {
      if (mockState.spanUpdateThrows) throw new Error('mock span.update fail');
      return span;
    }),
    event: vi.fn(() => {
      if (mockState.spanEventThrows) throw new Error('mock span.event fail');
      return span;
    }),
  };
  mockState.spans.push(span);
  return span;
}

function makeTrace(): MockTrace {
  const trace: MockTrace = {
    span: vi.fn(() => {
      if (mockState.spanThrows) throw new Error('mock trace.span fail');
      return makeSpan();
    }),
    event: vi.fn(() => {
      if (mockState.traceEventThrows)
        throw new Error('mock trace.event fail');
      return trace;
    }),
    update: vi.fn(() => {
      if (mockState.traceUpdateThrows)
        throw new Error('mock trace.update fail');
      return trace;
    }),
  };
  mockState.traces.push(trace);
  return trace;
}

vi.mock('langfuse', () => {
  return {
    Langfuse: vi.fn().mockImplementation((args: unknown) => {
      mockState.constructorCalls.push([args]);
      if (mockState.ctorThrows) {
        throw new Error('mock Langfuse ctor fail');
      }
      const instance: MockLangfuseInstance = {
        trace: vi.fn(() => {
          if (mockState.traceThrows) throw new Error('mock langfuse.trace fail');
          return makeTrace();
        }),
        shutdownAsync: vi.fn(async () => {
          if (mockState.shutdownThrows)
            throw new Error('mock shutdownAsync fail');
        }),
      };
      mockState.instances.push(instance);
      return instance;
    }),
  };
});

// Import AFTER vi.mock so the mock takes effect.
const { createObservabilityClient } = await import('./langfuse-client.js');

const ENABLED_CONFIG: LangfuseConfig = {
  enabled: true,
  publicKey: 'pk-lf-test',
  secretKey: 'sk-lf-test',
  baseUrl: 'http://localhost:3001',
  enableProxy: false,
  sampleRate: 1,
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockState.constructorCalls = [];
  mockState.instances = [];
  mockState.traces = [];
  mockState.spans = [];
  mockState.ctorThrows = false;
  mockState.traceThrows = false;
  mockState.spanThrows = false;
  mockState.shutdownThrows = false;
  mockState.spanEndThrows = false;
  mockState.spanUpdateThrows = false;
  mockState.spanEventThrows = false;
  mockState.traceEventThrows = false;
  mockState.traceUpdateThrows = false;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// -----------------------------------------------------------------------------
// Disabled-mode no-op contract
// -----------------------------------------------------------------------------

describe('createObservabilityClient — disabled mode', () => {
  const DISABLED: LangfuseConfig = { enabled: false };

  it('returns a no-op client without instantiating Langfuse', () => {
    const client = createObservabilityClient(DISABLED);
    expect(client).toBeDefined();
    expect(mockState.constructorCalls).toHaveLength(0);
  });

  it('every method is a safe no-op', async () => {
    const client = createObservabilityClient(DISABLED);
    const run = client.startRunTrace({
      run_id: 'r1',
      requirement_id: 'q1',
      project_id: 'p1',
      pipeline_id: 'pl1',
    });
    expect(run).toBeDefined();
    const stage = run.startStage({ stage_name: 'analysis', index: 0 });
    expect(stage).toBeDefined();
    const finishedEvent: ClaudeStageEvent = {
      kind: 'finished',
      exit_code: 0,
      total_cost_usd: 1,
      num_turns: 2,
      duration_ms: 3,
      usage: {},
    };
    stage.ingestClaudeEvent(finishedEvent);
    stage.finish({ status: 'success', metrics: { total_cost_usd: 1 } });
    const event: PipelineEvent = {
      kind: 'run_started',
      run_id: 'r1',
      requirement_id: 'q1',
      at: '2026-04-26T00:00:00Z',
    };
    run.ingestEvent(event);
    run.finish({ status: 'completed' });
    expect(client.proxyEnvVars()).toEqual({});
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('proxyEnvVars returns {} even if enableProxy true (disabled wins)', () => {
    const client = createObservabilityClient({
      enabled: false,
      enableProxy: true,
      baseUrl: 'http://localhost:3001',
    });
    expect(client.proxyEnvVars()).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// Enabled-mode happy path
// -----------------------------------------------------------------------------

describe('createObservabilityClient — enabled mode', () => {
  it('instantiates Langfuse with publicKey/secretKey/baseUrl', () => {
    createObservabilityClient(ENABLED_CONFIG);
    expect(mockState.constructorCalls).toHaveLength(1);
    expect(mockState.constructorCalls[0]?.[0]).toEqual({
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
      baseUrl: 'http://localhost:3001',
    });
  });

  it('startRunTrace calls langfuse.trace with run_id as id and tagged metadata', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    client.startRunTrace({
      run_id: 'run-1',
      requirement_id: 'req-1',
      project_id: 'proj-1',
      pipeline_id: 'pipe-1',
    });
    const instance = mockState.instances[0];
    expect(instance).toBeDefined();
    expect(instance?.trace).toHaveBeenCalledTimes(1);
    const traceArg = instance?.trace.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(traceArg['id']).toBe('run-1');
    expect(traceArg['name']).toBe('pipeline-run:pipe-1');
    expect(traceArg['metadata']).toMatchObject({
      run_id: 'run-1',
      requirement_id: 'req-1',
      project_id: 'proj-1',
      pipeline_id: 'pipe-1',
    });
    expect(traceArg['tags']).toContain('pipeline-run');
    expect(traceArg['tags']).toContain('project:proj-1');
  });

  it('startStage calls trace.span with stage_name and index metadata', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'run-1',
      requirement_id: 'req-1',
      project_id: 'proj-1',
      pipeline_id: 'pipe-1',
    });
    run.startStage({ stage_name: 'design', index: 1 });
    const trace = mockState.traces[0];
    expect(trace?.span).toHaveBeenCalledTimes(1);
    const spanArg = trace?.span.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spanArg['name']).toBe('stage:design');
    expect(spanArg['metadata']).toMatchObject({
      stage_name: 'design',
      stage_index: 1,
    });
  });

  it('ingestClaudeEvent finished records metrics on the span', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'run-1',
      requirement_id: 'req-1',
      project_id: 'proj-1',
      pipeline_id: 'pipe-1',
    });
    const stage = run.startStage({ stage_name: 'design', index: 0 });
    const finished: ClaudeStageEvent = {
      kind: 'finished',
      exit_code: 0,
      total_cost_usd: 0.42,
      num_turns: 7,
      duration_ms: 9001,
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    stage.ingestClaudeEvent(finished);
    const span = mockState.spans[0];
    expect(span?.update).toHaveBeenCalled();
    const updateArg = span?.update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(updateArg['metadata']).toMatchObject({
      exit_code: 0,
      total_cost_usd: 0.42,
      num_turns: 7,
      duration_ms: 9001,
    });
  });

  it('ingestClaudeEvent tool_use records a span event', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'run-1',
      requirement_id: 'req-1',
      project_id: 'proj-1',
      pipeline_id: 'pipe-1',
    });
    const stage = run.startStage({ stage_name: 'design', index: 0 });
    stage.ingestClaudeEvent({
      kind: 'tool_use',
      tool: 'Read',
      id: 'tool-1',
      input: { path: '/x' },
    });
    const span = mockState.spans[0];
    expect(span?.event).toHaveBeenCalledTimes(1);
    const eventArg = span?.event.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(eventArg['name']).toBe('tool_use:Read');
    expect(eventArg['metadata']).toMatchObject({
      tool: 'Read',
      tool_use_id: 'tool-1',
    });
  });

  it('ingestClaudeEvent does NOT ship assistant_text or tool_result chunks', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const stage = run.startStage({ stage_name: 's', index: 0 });
    stage.ingestClaudeEvent({ kind: 'assistant_text', text: 'noisy' });
    stage.ingestClaudeEvent({
      kind: 'tool_result',
      tool_use_id: 't',
      content: 'noisy',
      is_error: false,
    });
    const span = mockState.spans[0];
    expect(span?.event).not.toHaveBeenCalled();
    expect(span?.update).not.toHaveBeenCalled();
  });

  it('stage.finish calls span.end with status level mapped correctly', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const stage = run.startStage({ stage_name: 's', index: 0 });
    stage.finish({
      status: 'success',
      metrics: { total_cost_usd: 1, num_turns: 2 },
    });
    const span = mockState.spans[0];
    expect(span?.end).toHaveBeenCalledTimes(1);
    const endArg = span?.end.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(endArg['level']).toBe('DEFAULT');
    expect(endArg['metadata']).toMatchObject({
      status: 'success',
      total_cost_usd: 1,
      num_turns: 2,
    });
  });

  it('stage.finish maps gate_blocked → WARNING and failure → ERROR', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const blocked = run.startStage({ stage_name: 'a', index: 0 });
    blocked.finish({ status: 'gate_blocked' });
    const failed = run.startStage({ stage_name: 'b', index: 1 });
    failed.finish({ status: 'failure' });

    const blockedSpan = mockState.spans[0];
    const failedSpan = mockState.spans[1];
    expect(
      (blockedSpan?.end.mock.calls[0]?.[0] as Record<string, unknown>)['level'],
    ).toBe('WARNING');
    expect(
      (failedSpan?.end.mock.calls[0]?.[0] as Record<string, unknown>)['level'],
    ).toBe('ERROR');
  });

  it('ingestEvent records pipeline events on the trace', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const ev: PipelineEvent = {
      kind: 'gate_required',
      run_id: 'r',
      stage_name: 'design',
      review_targets: ['design.md'],
      at: '2026-04-26T00:00:00.000Z',
    };
    run.ingestEvent(ev);
    const trace = mockState.traces[0];
    expect(trace?.event).toHaveBeenCalledTimes(1);
    const eventArg = trace?.event.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(eventArg['name']).toBe('pipeline:gate_required');
  });

  it('run.finish updates the trace with final status', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    run.finish({ status: 'completed' });
    const trace = mockState.traces[0];
    expect(trace?.update).toHaveBeenCalledTimes(1);
    const updateArg = trace?.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg['metadata']).toMatchObject({ final_status: 'completed' });
  });

  it('shutdown calls langfuse.shutdownAsync', async () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    await client.shutdown();
    const instance = mockState.instances[0];
    expect(instance?.shutdownAsync).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Proxy env vars
// -----------------------------------------------------------------------------

describe('proxyEnvVars', () => {
  it('returns ANTHROPIC_BASE_URL when proxy enabled and baseUrl set', () => {
    const client = createObservabilityClient({
      ...ENABLED_CONFIG,
      enableProxy: true,
      baseUrl: 'https://langfuse.example.com',
    });
    expect(client.proxyEnvVars()).toEqual({
      ANTHROPIC_BASE_URL: 'https://langfuse.example.com',
    });
  });

  it('returns {} when proxy is disabled', () => {
    const client = createObservabilityClient({
      ...ENABLED_CONFIG,
      enableProxy: false,
    });
    expect(client.proxyEnvVars()).toEqual({});
  });

  it('returns {} when proxy enabled but baseUrl is empty', () => {
    const client = createObservabilityClient({
      ...ENABLED_CONFIG,
      enableProxy: true,
      baseUrl: '',
    });
    expect(client.proxyEnvVars()).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// Failure isolation: SDK errors must NEVER propagate
// -----------------------------------------------------------------------------

describe('failure isolation', () => {
  it('Langfuse constructor throwing degrades to a safe no-op client', async () => {
    mockState.ctorThrows = true;
    const client = createObservabilityClient(ENABLED_CONFIG);
    expect(warnSpy).toHaveBeenCalled();
    // Subsequent calls must not throw and must produce no-op handles.
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const stage = run.startStage({ stage_name: 's', index: 0 });
    stage.finish({ status: 'success' });
    run.finish({ status: 'completed' });
    expect(client.proxyEnvVars()).toEqual({});
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it('langfuse.trace() throwing is swallowed; downstream calls remain safe', () => {
    mockState.traceThrows = true;
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    expect(warnSpy).toHaveBeenCalled();
    // No real trace exists, but every method on the run must still be safe.
    const stage = run.startStage({ stage_name: 's', index: 0 });
    stage.ingestClaudeEvent({
      kind: 'finished',
      exit_code: 0,
      total_cost_usd: 1,
      num_turns: 1,
      duration_ms: 1,
    });
    stage.finish({ status: 'success' });
    run.ingestEvent({
      kind: 'run_started',
      run_id: 'r',
      requirement_id: 'q',
      at: '2026-04-26T00:00:00Z',
    });
    run.finish({ status: 'completed' });
  });

  it('trace.span() throwing returns a safe no-op stage handle', () => {
    mockState.spanThrows = true;
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const stage = run.startStage({ stage_name: 's', index: 0 });
    expect(warnSpy).toHaveBeenCalled();
    // Interactions on the no-op stage must not throw.
    stage.ingestClaudeEvent({ kind: 'tool_use', tool: 'X', id: 'i', input: {} });
    stage.finish({ status: 'success' });
  });

  it('span.update / span.event / span.end throws are swallowed', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const stage = run.startStage({ stage_name: 's', index: 0 });
    mockState.spanUpdateThrows = true;
    mockState.spanEventThrows = true;
    mockState.spanEndThrows = true;
    stage.ingestClaudeEvent({
      kind: 'finished',
      exit_code: 0,
      total_cost_usd: 1,
      num_turns: 1,
      duration_ms: 1,
    });
    stage.ingestClaudeEvent({
      kind: 'tool_use',
      tool: 'X',
      id: 'i',
      input: {},
    });
    stage.finish({ status: 'success' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('trace.update / trace.event throws are swallowed', () => {
    const client = createObservabilityClient(ENABLED_CONFIG);
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    mockState.traceEventThrows = true;
    mockState.traceUpdateThrows = true;
    run.ingestEvent({
      kind: 'run_completed',
      run_id: 'r',
      at: '2026-04-26T00:00:00Z',
    });
    run.finish({ status: 'completed' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('shutdownAsync throwing does not propagate', async () => {
    mockState.shutdownThrows = true;
    const client = createObservabilityClient(ENABLED_CONFIG);
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Sampling
// -----------------------------------------------------------------------------

describe('sampling', () => {
  it('sampleRate=0 skips span creation but trace remains', () => {
    const client = createObservabilityClient({
      ...ENABLED_CONFIG,
      sampleRate: 0,
    });
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    const stage = run.startStage({ stage_name: 's', index: 0 });
    // No span call should have occurred — Math.random() >= 0 is always true.
    const trace = mockState.traces[0];
    expect(trace?.span).not.toHaveBeenCalled();
    // Returned handle must still be safe.
    stage.ingestClaudeEvent({
      kind: 'finished',
      exit_code: 0,
      total_cost_usd: 1,
      num_turns: 1,
      duration_ms: 1,
    });
    stage.finish({ status: 'success' });
  });

  it('sampleRate=1 always creates a span', () => {
    const client = createObservabilityClient({
      ...ENABLED_CONFIG,
      sampleRate: 1,
    });
    const run = client.startRunTrace({
      run_id: 'r',
      requirement_id: 'q',
      project_id: 'p',
      pipeline_id: 'pl',
    });
    run.startStage({ stage_name: 's', index: 0 });
    const trace = mockState.traces[0];
    expect(trace?.span).toHaveBeenCalledTimes(1);
  });
});
