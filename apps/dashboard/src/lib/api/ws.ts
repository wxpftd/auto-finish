/**
 * Browser-side WebSocket client for the orchestrator's event bridge.
 *
 * Wire protocol mirrors `apps/orchestrator/src/eventbus/websocket-server.ts`:
 *
 *   client -> server (immediately on open):
 *     { type: 'subscribe', filter: 'run:abc' }
 *
 *   server -> client (acknowledgement):
 *     { type: 'subscribed', filter: '...' }
 *
 *   server -> client (each matching message):
 *     { topic: string, event: PipelineEvent, emitted_at: string }
 *
 * Reconnect: on transport close (excluding intentional `close()` and the
 * orchestrator's auth-rejected code 4401) we exponential-backoff up to
 * `maxReconnectAttempts` (default 5).
 */

import { env as publicEnv } from '$env/dynamic/public';
import type { BusMessage, PipelineEvent } from './types.js';

export interface WsClientOpts {
  /**
   * Full WS URL or a base URL — we'll append `/ws` if missing. When omitted,
   * resolve from `(globalThis as any).__PUBLIC_WS_BASE_URL__` first, then fall
   * back to `__PUBLIC_API_BASE_URL__` (rewriting `http(s)` to `ws(s)`), then
   * to `ws://localhost:3001/ws`.
   */
  baseUrl?: string;
  /** Topic filter, e.g. `run:abc123` or `*`. */
  filter: string;
  /** Called for each PipelineEvent in a matching BusMessage. */
  onEvent: (event: PipelineEvent, message: BusMessage) => void;
  /** Optional close hook. */
  onClose?: (code: number, reason: string) => void;
  /** Optional error hook. */
  onError?: (err: Event) => void;
  /** Override the global WebSocket constructor (tests). */
  WebSocketImpl?: WebSocketLike;
  /** Max reconnect attempts after an unexpected close. Default 5. */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay in ms. Default 250. */
  reconnectInitialDelayMs?: number;
}

export interface WsClientHandle {
  /** Idempotent — closes the underlying socket and cancels reconnects. */
  close(): void;
  /** Resolves when the first `{type:'subscribed'}` ack arrives. */
  ready: Promise<void>;
}

/** Minimal WebSocket-shaped constructor (matches the browser global). */
export interface WebSocketLike {
  new (url: string): WebSocketInstanceLike;
  readonly OPEN: number;
  readonly CLOSED: number;
  readonly CONNECTING: number;
  readonly CLOSING: number;
}

export interface WebSocketInstanceLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (ev: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (ev: Event) => void): void;
}

const AUTH_REJECTED_CLOSE_CODE = 4401;

function resolveBaseUrl(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const wsExplicit = publicEnv?.PUBLIC_WS_BASE_URL;
  if (typeof wsExplicit === 'string' && wsExplicit.length > 0) return wsExplicit;
  const apiExplicit = publicEnv?.PUBLIC_API_BASE_URL;
  if (typeof apiExplicit === 'string' && apiExplicit.length > 0) {
    return apiExplicit.replace(/^http/, 'ws');
  }
  return 'ws://localhost:3001';
}

function buildWsUrl(base: string): string {
  // Allow callers to pass either a full ws(s):// URL ending in /ws, or a base.
  const trimmed = base.replace(/\/$/, '');
  if (/\/ws$/.test(trimmed)) return trimmed;
  return `${trimmed}/ws`;
}

interface ParsedFrame {
  /** Server-side ack of subscribe. */
  type?: 'subscribed' | 'pong' | string;
  filter?: string;
  /** BusMessage envelope fields. */
  topic?: string;
  event?: PipelineEvent;
  emitted_at?: string;
}

function parseFrame(raw: unknown): ParsedFrame | null {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw instanceof ArrayBuffer) {
    text = new TextDecoder().decode(new Uint8Array(raw));
  } else if (
    typeof raw === 'object' &&
    raw !== null &&
    'toString' in raw &&
    typeof (raw as { toString: () => string }).toString === 'function'
  ) {
    text = (raw as { toString: () => string }).toString();
  } else {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as ParsedFrame;
  } catch {
    return null;
  }
}

export function connectWs(opts: WsClientOpts): WsClientHandle {
  const url = buildWsUrl(resolveBaseUrl(opts.baseUrl));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Impl: WebSocketLike =
    opts.WebSocketImpl ?? ((globalThis as any).WebSocket as WebSocketLike);
  if (typeof Impl !== 'function') {
    throw new Error('WebSocket is not available in this environment');
  }

  const maxAttempts = opts.maxReconnectAttempts ?? 5;
  const initialDelay = opts.reconnectInitialDelayMs ?? 250;

  let attempt = 0;
  let closed = false;
  let socket: WebSocketInstanceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Attach a no-op catcher so a rejection (e.g. from `close()` before any
  // caller awaits `ready`) doesn't escape as an unhandled rejection. Real
  // callers that .then/.catch the promise still see the rejection.
  ready.catch(() => {});
  let readyResolved = false;

  const settleReady = (success: boolean, err?: Error): void => {
    if (readyResolved) return;
    readyResolved = true;
    if (success) {
      resolveReady();
    } else {
      rejectReady(err ?? new Error('ws closed before ready'));
    }
  };

  const open = (): void => {
    if (closed) return;
    const ws = new Impl(url);
    socket = ws;

    ws.addEventListener('open', () => {
      if (closed) return;
      try {
        ws.send(JSON.stringify({ type: 'subscribe', filter: opts.filter }));
      } catch (err) {
        // Most likely "still CONNECTING" — let the close handler trigger
        // reconnect; surface as error too so callers see it.
        if (opts.onError) {
          // Synthesise an Event-shaped object; tests / handlers only treat it
          // opaquely.
          opts.onError(new Event('error'));
        }
        void err;
      }
    });

    ws.addEventListener('message', (ev: { data: unknown }) => {
      const frame = parseFrame(ev.data);
      if (frame === null) return;

      if (frame.type === 'subscribed') {
        settleReady(true);
        return;
      }
      if (frame.type === 'pong') {
        return; // ignore heartbeats
      }
      // BusMessage envelope.
      if (
        typeof frame.topic === 'string' &&
        typeof frame.emitted_at === 'string' &&
        frame.event !== undefined
      ) {
        const message: BusMessage = {
          topic: frame.topic,
          event: frame.event,
          emitted_at: frame.emitted_at,
        };
        try {
          opts.onEvent(message.event, message);
        } catch (err) {
          // A throwing handler must not break the connection.
          // eslint-disable-next-line no-console
          console.error('[ws] onEvent handler threw:', err);
        }
      }
    });

    ws.addEventListener('error', (err: Event) => {
      if (opts.onError) opts.onError(err);
    });

    ws.addEventListener(
      'close',
      (ev: { code: number; reason: string }) => {
        socket = null;
        if (opts.onClose) opts.onClose(ev.code, ev.reason);
        if (closed) {
          settleReady(false, new Error('ws closed by client'));
          return;
        }
        if (ev.code === AUTH_REJECTED_CLOSE_CODE) {
          settleReady(false, new Error('ws authentication rejected'));
          return;
        }
        // Schedule reconnect with exponential backoff.
        attempt += 1;
        if (attempt > maxAttempts) {
          settleReady(false, new Error('ws gave up after max reconnect attempts'));
          return;
        }
        const delay = initialDelay * 2 ** (attempt - 1);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!closed) open();
        }, delay);
      },
    );
  };

  open();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket !== null) {
        try {
          socket.close(1000, 'client close');
        } catch {
          /* ignore */
        }
        socket = null;
      }
      settleReady(false, new Error('ws closed by client'));
    },
    ready,
  };
}
