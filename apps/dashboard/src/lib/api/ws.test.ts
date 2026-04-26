import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectWs } from './ws.js';
import type { PipelineEvent } from './types.js';

type Listener = (...args: unknown[]) => void;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  /** Track every constructed instance so tests can assert lifecycle. */
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  url: string;
  /** Frames the client has sent to the "server". */
  sent: string[] = [];

  private listeners: Map<string, Set<Listener>> = new Map();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  /** Test helper: dispatch an event of `type` to all listeners. */
  dispatch(type: string, payload?: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }

  /** Test helper: simulate the underlying socket transitioning to OPEN. */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch('open');
  }

  /** Test helper: simulate the server sending a frame. */
  serverSend(frame: unknown): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.dispatch('message', { data });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', { code, reason });
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
});

describe('connectWs', () => {
  it('sends subscribe on open and resolves ready on subscribed ack', async () => {
    const events: PipelineEvent[] = [];
    const handle = connectWs({
      baseUrl: 'ws://test.local',
      filter: 'run:abc',
      onEvent: (ev) => events.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketImpl: MockWebSocket as unknown as any,
    });

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws?.url).toBe('ws://test.local/ws');

    ws?.open();
    expect(ws?.sent).toEqual([JSON.stringify({ type: 'subscribe', filter: 'run:abc' })]);

    ws?.serverSend({ type: 'subscribed', filter: 'run:abc' });
    await expect(handle.ready).resolves.toBeUndefined();
    handle.close();
  });

  it('dispatches BusMessage envelopes to onEvent', async () => {
    const events: PipelineEvent[] = [];
    const handle = connectWs({
      baseUrl: 'ws://test.local',
      filter: 'run:abc',
      onEvent: (ev) => events.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketImpl: MockWebSocket as unknown as any,
    });

    const ws = MockWebSocket.instances[0];
    ws?.open();
    ws?.serverSend({ type: 'subscribed', filter: 'run:abc' });
    await handle.ready;

    ws?.serverSend({
      topic: 'run:abc',
      event: {
        kind: 'stage_started',
        run_id: 'abc',
        stage_name: 'design',
        at: '2025-01-01T00:00:00Z',
      },
      emitted_at: '2025-01-01T00:00:00Z',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'stage_started', stage_name: 'design' });
    handle.close();
  });

  it('appends /ws when only a base URL is supplied', () => {
    connectWs({
      baseUrl: 'ws://example.test:9999',
      filter: '*',
      onEvent: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketImpl: MockWebSocket as unknown as any,
    });
    expect(MockWebSocket.instances[0]?.url).toBe('ws://example.test:9999/ws');
  });

  it('does not append /ws if base already ends with /ws', () => {
    connectWs({
      baseUrl: 'ws://example.test:9999/ws',
      filter: '*',
      onEvent: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketImpl: MockWebSocket as unknown as any,
    });
    expect(MockWebSocket.instances[0]?.url).toBe('ws://example.test:9999/ws');
  });

  it('reconnects with backoff after an unexpected close', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const handle = connectWs({
      baseUrl: 'ws://test.local',
      filter: '*',
      onEvent: () => {},
      onClose,
      maxReconnectAttempts: 3,
      reconnectInitialDelayMs: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketImpl: MockWebSocket as unknown as any,
    });

    const first = MockWebSocket.instances[0];
    first?.open();
    first?.close(1011, 'transient'); // unexpected close (not 4401, not client)

    expect(onClose).toHaveBeenCalledWith(1011, 'transient');

    // Drain the first backoff timer (10ms).
    await vi.advanceTimersByTimeAsync(15);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second close — backoff doubles.
    const second = MockWebSocket.instances[1];
    second?.open();
    second?.close(1011, 'transient2');
    await vi.advanceTimersByTimeAsync(25);
    expect(MockWebSocket.instances).toHaveLength(3);

    handle.close();
    vi.useRealTimers();
  });

  it('rejects ready when the server closes with auth-rejected code 4401', async () => {
    const handle = connectWs({
      baseUrl: 'ws://test.local',
      filter: '*',
      onEvent: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketImpl: MockWebSocket as unknown as any,
    });
    const ws = MockWebSocket.instances[0];
    ws?.open();
    ws?.close(4401, 'unauthorized');

    await expect(handle.ready).rejects.toThrow(/auth/);
  });

  it('close() is idempotent and rejects ready', async () => {
    const handle = connectWs({
      baseUrl: 'ws://test.local',
      filter: '*',
      onEvent: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      WebSocketImpl: MockWebSocket as unknown as any,
    });
    handle.close();
    handle.close(); // no throw
    await expect(handle.ready).rejects.toThrow(/closed by client/);
  });
});
