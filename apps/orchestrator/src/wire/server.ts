/**
 * Single-port HTTP + WebSocket bootstrap for the orchestrator.
 *
 * `startServer()` opens (or accepts) a SQLite DB, applies migrations, builds
 * the Hono API, and starts a node `http.Server` via `@hono/node-server`. The
 * SAME http server is used to handle WebSocket upgrades on `wsPath`
 * (default `/ws`), so dashboard clients only ever talk to one port.
 *
 * Wire protocol mirrors `src/eventbus/websocket-server.ts`:
 *
 *   client -> server:  {"type":"subscribe","filter":"run:abc,gate:pending"}
 *   server -> client:  {"type":"subscribed","filter":"<echoed>"}
 *   server -> client:  {topic, event, emitted_at} for each matching BusMessage
 *
 * Auth: if `authenticateWs` resolves to `false` we complete the upgrade and
 * then close with code `4401`. The 401-via-raw-socket shape from the plan
 * surfaces as code 1006 on the client which collides with generic abnormal
 * closures; the 4xxx code lets tests/dashboard distinguish auth rejection.
 *
 * Returned handle exposes the bus + db + close() so tests can publish events
 * directly and tear the whole stack down between cases.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { WebSocket, WebSocketServer } from 'ws';

import { buildApp } from '../api/app.js';
import { createDb, runMigrations } from '../db/index.js';
import type { Db, DbHandle } from '../db/index.js';
import { EventBus } from '../eventbus/index.js';
import type { BusMessage } from '../eventbus/index.js';

/** Custom close code emitted when `authenticateWs` rejects. Mirrors the
 * value used by `src/eventbus/websocket-server.ts` so dashboard clients
 * can use a single constant. */
export const AUTH_REJECTED_CLOSE_CODE = 4401;

export interface ServerHandle {
  httpServer: HttpServer;
  wss: WebSocketServer;
  bus: EventBus;
  db: Db;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface StartServerOpts {
  /** Default 3000. Pass 0 for an OS-assigned port (used by tests). */
  port?: number;
  /** Default './auto-finish.sqlite'. Pass ':memory:' for tests. */
  dbPath?: string;
  /** Inject a pre-built bus (lets tests publish directly). */
  bus?: EventBus;
  /** Override the WS path; default `/ws`. */
  wsPath?: string;
  /** Auth callback for WS upgrade requests. Resolve `false` to reject. */
  authenticateWs?: (req: IncomingMessage) => Promise<boolean> | boolean;
}

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

/**
 * Wire one connected WebSocket to the bus. Pulled out of `connection` so
 * the auth-gate can run before any subscribe/ping handling registers.
 */
function attachBusBridge(ws: WebSocket, bus: EventBus): void {
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    console.error('[wire] client socket error:', err);
    cleanup();
  });

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const msg = parseClientMessage(text);
    if (msg === null) {
      console.error('[wire] dropping malformed frame:', text);
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
      return;
    }

    // subscribe — only the FIRST one per connection wires the bus, otherwise
    // a client could quietly stack listeners with broader filters.
    if (unsubscribe !== null) return;
    unsubscribe = bus.subscribe(msg.filter, (busMsg: BusMessage) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          topic: busMsg.topic,
          event: busMsg.event,
          emitted_at: busMsg.emitted_at,
        }),
      );
    });
    ws.send(JSON.stringify({ type: 'subscribed', filter: msg.filter }));
  });
}

export async function startServer(
  opts: StartServerOpts = {},
): Promise<ServerHandle> {
  const port = opts.port ?? 3000;
  const dbPath = opts.dbPath ?? './auto-finish.sqlite';
  const wsPath = opts.wsPath ?? '/ws';
  const bus = opts.bus ?? new EventBus();

  // 1. Open DB + migrate.
  const handle: DbHandle = createDb(dbPath);
  runMigrations(handle.db);

  // 2. Build Hono app. The bus is threaded into the app so gate decisions
  // can publish `gate_decided` events on the same in-process bus the runner
  // subscribes to — closing the loop for sub-50ms gate resumption.
  const app = buildApp({ db: handle.db, bus });

  // 3. Start http server. `serve()` v2 returns `ServerType` (a union of
  // http.Server | http2.Server | http2.SecureServer); at runtime this is an
  // `http.Server` when we don't override `createServer`, but the union typing
  // doesn't let TS see that, so cast deliberately.
  const { httpServer, boundPort } = await new Promise<{
    httpServer: HttpServer;
    boundPort: number;
  }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port }, (info: AddressInfo) => {
      resolve({
        httpServer: server as unknown as HttpServer,
        boundPort: info.port,
      });
    });
    server.on('error', (err) => reject(err));
  });

  // 4. WebSocket server in noServer mode — we drive the upgrade ourselves so
  // we can gate on `wsPath` and run the auth callback.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const authPromise = opts.authenticateWs
        ? Promise.resolve(opts.authenticateWs(req))
        : Promise.resolve(true);

      authPromise
        .then((ok) => {
          if (!ok) {
            // Post-upgrade close with a custom 4xxx code so the client sees
            // a deterministic non-1000 status (not the 1006 produced by a
            // raw socket destroy mid-handshake).
            ws.close(AUTH_REJECTED_CLOSE_CODE, 'unauthorized');
            return;
          }
          attachBusBridge(ws, bus);
        })
        .catch((err: unknown) => {
          console.error('[wire] authenticateWs threw:', err);
          ws.close(AUTH_REJECTED_CLOSE_CODE, 'unauthorized');
        });
    });
  });

  const url = `http://127.0.0.1:${boundPort}`;

  const close = async (): Promise<void> => {
    // Terminate every still-connected ws first so wss.close() resolves
    // promptly. Mirrors the eventbus/websocket-server.ts pattern.
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch (err) {
        console.error('[wire] terminate client failed:', err);
      }
    }
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => {
        if (err !== undefined && err !== null) reject(err);
        else resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err !== undefined && err !== null) reject(err);
        else resolve();
      });
    });
    try {
      handle.sqlite.close();
    } catch (err) {
      console.error('[wire] sqlite close failed:', err);
    }
  };

  return {
    httpServer,
    wss,
    bus,
    db: handle.db,
    port: boundPort,
    url,
    close,
  };
}
