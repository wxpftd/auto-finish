import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { PipelineEvent } from '../pipeline/index.js';
import { EventBus, type BusMessage } from './bus.js';
import {
  AUTH_REJECTED_CLOSE_CODE,
  startWebSocketServer,
  type WsServerHandle,
  type WsServerOpts,
} from './websocket-server.js';

const BASE_AT = '2026-04-26T00:00:00.000Z';

function makeEvent(run_id: string): PipelineEvent {
  return {
    kind: 'run_started',
    run_id,
    requirement_id: 'req-1',
    at: BASE_AT,
  };
}

function makeMessage(topic: string, run_id = 'r1'): BusMessage {
  return {
    topic,
    event: makeEvent(run_id),
    emitted_at: BASE_AT,
  };
}

interface Harness {
  bus: EventBus;
  handle: WsServerHandle;
  port: number;
  url: (subPath?: string) => string;
}

async function startHarness(
  overrides: Partial<WsServerOpts> = {},
): Promise<Harness> {
  const bus = new EventBus();
  const handle = startWebSocketServer({ bus, port: 0, ...overrides });
  const port = await handle.listening;
  const path = overrides.path ?? '/ws';
  return {
    bus,
    handle,
    port,
    url: (subPath = path) => `ws://127.0.0.1:${port}${subPath}`,
  };
}

/**
 * Wait for the next JSON-decoded message that satisfies `predicate`.
 * Times out so a failed expectation doesn't hang the suite.
 */
function waitForMessage<T = unknown>(
  ws: WebSocket,
  predicate: (parsed: T) => boolean,
  timeoutMs = 800,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error('timed out waiting for matching message'));
    }, timeoutMs);

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      try {
        const parsed = JSON.parse(text) as T;
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.removeListener('message', onMessage);
          resolve(parsed);
        }
      } catch {
        /* ignore non-json frames */
      }
    };
    ws.on('message', onMessage);
  });
}

function waitForOpen(ws: WebSocket, timeoutMs = 800): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ws open timed out')),
      timeoutMs,
    );
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClose(
  ws: WebSocket,
  timeoutMs = 800,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ws close timed out')),
      timeoutMs,
    );
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

describe('startWebSocketServer', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(async () => {
    if (harness !== null) {
      await harness.handle.close();
      harness = null;
    }
  });

  it('binds to an OS-assigned port', async () => {
    harness = await startHarness();
    expect(harness.port).toBeGreaterThan(0);
  });

  it('forwards bus messages matching the subscribe filter', async () => {
    harness = await startHarness();
    const ws = new WebSocket(harness.url());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'subscribe', filter: 'run:r1' }));

    // Wait for ack before publishing so we don't race the subscribe.
    await waitForMessage<{ type?: string }>(
      ws,
      (m) => m.type === 'subscribed',
    );

    const fwdPromise = waitForMessage<BusMessage & { type?: string }>(
      ws,
      (m) => m.type === undefined && m.topic === 'run:r1',
    );

    harness.bus.publish(makeMessage('run:other', 'skipped'));
    harness.bus.publish(makeMessage('run:r1', 'delivered'));

    const got = await fwdPromise;
    expect(got.topic).toBe('run:r1');
    expect(got.event.run_id).toBe('delivered');
    expect(got.emitted_at).toBe(BASE_AT);

    ws.close();
    await waitForClose(ws);
  });

  it('"*" filter receives broadcast across multiple topics', async () => {
    harness = await startHarness();
    const ws = new WebSocket(harness.url());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'subscribe', filter: '*' }));
    await waitForMessage<{ type?: string }>(
      ws,
      (m) => m.type === 'subscribed',
    );

    // Listen for each topic in series — same connection, sequential publishes.
    const promiseA = waitForMessage<BusMessage & { type?: string }>(
      ws,
      (m) => m.topic === 'topic-a',
    );
    harness.bus.publish(makeMessage('topic-a', 'a-run'));
    const a = await promiseA;
    expect(a.event.run_id).toBe('a-run');

    const promiseB = waitForMessage<BusMessage & { type?: string }>(
      ws,
      (m) => m.topic === 'topic-b',
    );
    harness.bus.publish(makeMessage('topic-b', 'b-run'));
    const b = await promiseB;
    expect(b.event.run_id).toBe('b-run');

    ws.close();
    await waitForClose(ws);
  });

  it('responds to ping with pong', async () => {
    harness = await startHarness();
    const ws = new WebSocket(harness.url());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'subscribe', filter: '*' }));
    await waitForMessage<{ type?: string }>(
      ws,
      (m) => m.type === 'subscribed',
    );

    const pongPromise = waitForMessage<{ type?: string; at?: string }>(
      ws,
      (m) => m.type === 'pong',
    );
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await pongPromise;
    expect(typeof pong.at).toBe('string');

    ws.close();
    await waitForClose(ws);
  });

  it('tolerates malformed frames', async () => {
    harness = await startHarness();
    const ws = new WebSocket(harness.url());
    await waitForOpen(ws);

    ws.send('not json');
    ws.send(JSON.stringify({ type: 'subscribe', filter: '*' }));
    await waitForMessage<{ type?: string }>(
      ws,
      (m) => m.type === 'subscribed',
    );

    const got = waitForMessage<BusMessage & { type?: string }>(
      ws,
      (m) => m.topic === 'topic-x',
    );
    harness.bus.publish(makeMessage('topic-x', 'still-works'));
    const msg = await got;
    expect(msg.event.run_id).toBe('still-works');

    ws.close();
    await waitForClose(ws);
  });

  it('rejects with custom close code when authenticate returns false', async () => {
    harness = await startHarness({ authenticate: () => false });
    const ws = new WebSocket(harness.url());

    const closeInfo = await waitForClose(ws);
    expect(closeInfo.code).toBe(AUTH_REJECTED_CLOSE_CODE);
  });

  it('rejects with custom close code when async authenticate returns false', async () => {
    harness = await startHarness({
      authenticate: async () => Promise.resolve(false),
    });
    const ws = new WebSocket(harness.url());

    const closeInfo = await waitForClose(ws);
    expect(closeInfo.code).toBe(AUTH_REJECTED_CLOSE_CODE);
  });

  it('two clients with overlapping filters both receive', async () => {
    harness = await startHarness();
    const wsAll = new WebSocket(harness.url());
    const wsRun = new WebSocket(harness.url());
    await Promise.all([waitForOpen(wsAll), waitForOpen(wsRun)]);

    wsAll.send(JSON.stringify({ type: 'subscribe', filter: '*' }));
    wsRun.send(JSON.stringify({ type: 'subscribe', filter: 'run:r1' }));

    await Promise.all([
      waitForMessage<{ type?: string }>(wsAll, (m) => m.type === 'subscribed'),
      waitForMessage<{ type?: string }>(wsRun, (m) => m.type === 'subscribed'),
    ]);

    const allP = waitForMessage<BusMessage & { type?: string }>(
      wsAll,
      (m) => m.topic === 'run:r1',
    );
    const runP = waitForMessage<BusMessage & { type?: string }>(
      wsRun,
      (m) => m.topic === 'run:r1',
    );

    harness.bus.publish(makeMessage('run:r1', 'shared'));

    const [allMsg, runMsg] = await Promise.all([allP, runP]);
    expect(allMsg.event.run_id).toBe('shared');
    expect(runMsg.event.run_id).toBe('shared');

    wsAll.close();
    wsRun.close();
    await Promise.all([waitForClose(wsAll), waitForClose(wsRun)]);
  });

  it('only the first subscribe per connection takes effect', async () => {
    harness = await startHarness();
    const ws = new WebSocket(harness.url());
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'subscribe', filter: 'run:r1' }));
    await waitForMessage<{ type?: string }>(
      ws,
      (m) => m.type === 'subscribed',
    );

    // Second subscribe with broader filter should be ignored.
    ws.send(JSON.stringify({ type: 'subscribe', filter: '*' }));

    const got = waitForMessage<BusMessage & { type?: string }>(
      ws,
      (m) => m.topic === 'run:r1',
    );
    harness.bus.publish(makeMessage('run:other', 'wrong'));
    harness.bus.publish(makeMessage('run:r1', 'right'));

    const msg = await got;
    expect(msg.event.run_id).toBe('right');

    ws.close();
    await waitForClose(ws);
  });
});
