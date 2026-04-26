/**
 * End-to-end test for the single-port HTTP + WebSocket bootstrap.
 *
 * Each case starts the server on port 0 (OS-assigned) against an in-memory
 * SQLite. `afterEach` ensures `handle.close()` runs so we don't leak http
 * listeners or socket handles.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { PipelineEvent } from '../pipeline/index.js';
import type { BusMessage } from '../eventbus/index.js';
import {
  AUTH_REJECTED_CLOSE_CODE,
  startServer,
  type ServerHandle,
} from './server.js';

const BASE_AT = '2026-04-26T00:00:00.000Z';

function makeMessage(topic: string, run_id = 'r1'): BusMessage {
  const event: PipelineEvent = {
    kind: 'run_started',
    run_id,
    requirement_id: 'req-1',
    at: BASE_AT,
  };
  return { topic, event, emitted_at: BASE_AT };
}

function wsUrl(handle: ServerHandle, path = '/ws'): string {
  return `${handle.url.replace(/^http/, 'ws')}${path}`;
}

function waitForOpen(ws: WebSocket, timeoutMs = 1500): Promise<void> {
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
  timeoutMs = 1500,
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

function waitForMessage<T = unknown>(
  ws: WebSocket,
  predicate: (parsed: T) => boolean,
  timeoutMs = 1500,
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

describe('startServer (single-port HTTP + WS)', () => {
  let handle: ServerHandle | null = null;

  beforeEach(() => {
    handle = null;
  });

  afterEach(async () => {
    if (handle !== null) {
      await handle.close();
      handle = null;
    }
  });

  it('serves /healthz over HTTP', async () => {
    handle = await startServer({ port: 0, dbPath: ':memory:' });
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`${handle.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('forwards bus messages over the same port via WS', async () => {
    handle = await startServer({ port: 0, dbPath: ':memory:' });
    const ws = new WebSocket(wsUrl(handle));
    await waitForOpen(ws);

    ws.send(JSON.stringify({ type: 'subscribe', filter: '*' }));
    await waitForMessage<{ type?: string }>(
      ws,
      (m) => m.type === 'subscribed',
    );

    const fwdPromise = waitForMessage<BusMessage & { type?: string }>(
      ws,
      (m) => m.type === undefined && m.topic === 'run:r1',
    );
    handle.bus.publish(makeMessage('run:r1', 'delivered'));
    const got = await fwdPromise;
    expect(got.topic).toBe('run:r1');
    expect(got.event.run_id).toBe('delivered');
    expect(got.emitted_at).toBe(BASE_AT);

    ws.close();
    await waitForClose(ws);
  });

  it('rejects WS upgrade for non-/ws paths', async () => {
    handle = await startServer({ port: 0, dbPath: ':memory:' });
    const ws = new WebSocket(`${handle.url.replace(/^http/, 'ws')}/nope`);
    // Server destroys the socket → client surfaces error or close.
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      ws.once('error', () => settle());
      ws.once('close', () => settle());
    });
  });

  it('closes the WS with the auth-reject code when authenticateWs returns false', async () => {
    handle = await startServer({
      port: 0,
      dbPath: ':memory:',
      authenticateWs: () => false,
    });
    const ws = new WebSocket(wsUrl(handle));
    const closeInfo = await waitForClose(ws);
    expect(closeInfo.code).toBe(AUTH_REJECTED_CLOSE_CODE);
    // Confirm the rejection code is OUTSIDE the 1000-range as advertised.
    expect(closeInfo.code).toBeGreaterThanOrEqual(4000);
  });

  it('honours an injected EventBus so producers can publish before clients connect', async () => {
    const { EventBus } = await import('../eventbus/index.js');
    const bus = new EventBus();
    handle = await startServer({ port: 0, dbPath: ':memory:', bus });
    expect(handle.bus).toBe(bus);

    const ws = new WebSocket(wsUrl(handle));
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'subscribe', filter: 'topic-x' }));
    await waitForMessage<{ type?: string }>(
      ws,
      (m) => m.type === 'subscribed',
    );

    const got = waitForMessage<BusMessage & { type?: string }>(
      ws,
      (m) => m.topic === 'topic-x',
    );
    bus.publish(makeMessage('topic-x', 'via-injected-bus'));
    const msg = await got;
    expect(msg.event.run_id).toBe('via-injected-bus');

    ws.close();
    await waitForClose(ws);
  });

  it('shutdown stops accepting HTTP after close()', async () => {
    handle = await startServer({ port: 0, dbPath: ':memory:' });
    const url = `${handle.url}/healthz`;
    const before = await fetch(url);
    expect(before.status).toBe(200);

    await handle.close();
    handle = null;

    let failed = false;
    try {
      await fetch(url);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
