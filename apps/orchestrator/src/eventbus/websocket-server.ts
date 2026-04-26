/**
 * WebSocket bridge for the in-process EventBus.
 *
 * Wire protocol (JSON messages, one per ws frame):
 *
 *   client -> server (first message after open):
 *     { "type": "subscribe", "filter": "run:abc,gate:pending" }
 *
 *   server -> client (acknowledgement, fired right after subscribe):
 *     { "type": "subscribed", "filter": "<echoed>" }
 *
 *   server -> client (every matching bus message):
 *     { "topic": "...", "event": { ... }, "emitted_at": "..." }
 *
 *   client -> server (heartbeat, optional, any time):
 *     { "type": "ping" }
 *   server -> client:
 *     { "type": "pong", "at": "<ISO8601>" }
 *
 * Auth: if `opts.authenticate` is provided we let the WS handshake complete
 * and then call the callback with the upgrade request. On `false` we close
 * the socket with code 4401 (custom "unauthorized") so the test suite — and
 * the dashboard client — can distinguish auth rejection from other closes.
 *
 * Error handling: malformed JSON / unknown message types are logged and
 * skipped. Subscribers that throw on the bus side are already swallowed by
 * the bus itself.
 */

import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import type { BusMessage, EventBus } from './bus.js';

export interface WsServerOpts {
  bus: EventBus;
  /** Default 3001. Pass 0 to let the OS pick (used by tests). */
  port?: number;
  /** Default '/ws'. */
  path?: string;
  /** Optional auth gate. Reject by returning (or resolving to) `false`. */
  authenticate?: (req: IncomingMessage) => Promise<boolean> | boolean;
}

export interface WsServerHandle {
  wss: WebSocketServer;
  /**
   * Resolves once the server has stopped listening AND every active client
   * has been closed.
   */
  close: () => Promise<void>;
  /** Resolves with the bound port once the server is listening. */
  listening: Promise<number>;
}

/** Custom close code used when `authenticate` rejects. */
export const AUTH_REJECTED_CLOSE_CODE = 4401;

/** Internal per-connection state. */
type ClientMessage =
  | { type: 'subscribe'; filter: string }
  | { type: 'ping' };

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const t = obj['type'];
    if (t === 'subscribe') {
      const filter = obj['filter'];
      if (typeof filter === 'string') {
        return { type: 'subscribe', filter };
      }
    } else if (t === 'ping') {
      return { type: 'ping' };
    }
  } catch {
    // fall through
  }
  return null;
}

export function startWebSocketServer(opts: WsServerOpts): WsServerHandle {
  const port = opts.port ?? 3001;
  const path = opts.path ?? '/ws';

  const wss = new WebSocketServer({ port, path });

  const listening = new Promise<number>((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve((addr as AddressInfo).port);
      } else {
        reject(new Error('WebSocketServer.address() returned non-object'));
      }
    });
    wss.once('error', (err) => reject(err));
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let unsubscribe: (() => void) | null = null;

    const cleanup = (): void => {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    ws.on('close', cleanup);
    ws.on('error', (err) => {
      console.error('[ws-server] client socket error:', err);
      cleanup();
    });

    const authPromise = opts.authenticate
      ? Promise.resolve(opts.authenticate(req))
      : Promise.resolve(true);

    authPromise
      .then((ok) => {
        if (!ok) {
          ws.close(AUTH_REJECTED_CLOSE_CODE, 'unauthorized');
          return;
        }

        ws.on('message', (data) => {
          const text =
            typeof data === 'string' ? data : data.toString('utf8');
          const msg = parseClientMessage(text);
          if (msg === null) {
            console.error('[ws-server] dropping malformed frame:', text);
            return;
          }

          if (msg.type === 'ping') {
            ws.send(
              JSON.stringify({ type: 'pong', at: new Date().toISOString() }),
            );
            return;
          }

          // subscribe — only honour the FIRST subscribe per connection so
          // a client can't quietly stack listeners.
          if (unsubscribe !== null) {
            return;
          }
          unsubscribe = opts.bus.subscribe(msg.filter, (busMsg: BusMessage) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(
              JSON.stringify({
                topic: busMsg.topic,
                event: busMsg.event,
                emitted_at: busMsg.emitted_at,
              }),
            );
          });
          ws.send(
            JSON.stringify({ type: 'subscribed', filter: msg.filter }),
          );
        });
      })
      .catch((err: unknown) => {
        console.error('[ws-server] authenticate threw:', err);
        ws.close(AUTH_REJECTED_CLOSE_CODE, 'unauthorized');
      });
  });

  const close = async (): Promise<void> => {
    // Close every still-open client first so wss.close() resolves promptly.
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch (err) {
        console.error('[ws-server] terminate client failed:', err);
      }
    }
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  return { wss, close, listening };
}
