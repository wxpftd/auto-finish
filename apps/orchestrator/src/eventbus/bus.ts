/**
 * Typed in-process event bus.
 *
 * Wraps `mitt` for synchronous fan-out and adds:
 *  - Topic-based filter syntax (exact match, comma-separated, '*' wildcard)
 *  - AsyncIterable conversion with bounded backpressure (drop-oldest)
 *
 * Subscribers run synchronously on `publish`. A throwing handler is caught
 * and logged via `console.error` so it cannot break sibling subscribers.
 */

// `mitt` ships ES default-export typings but the package resolves as CJS under
// NodeNext, and `verbatimModuleSyntax` forbids the classic synthetic-default
// sugar. Pull the factory off the module namespace explicitly.
import * as mittNs from 'mitt';
import type { Emitter, EventType } from 'mitt';

type MittFactory = <Events extends Record<EventType, unknown>>() => Emitter<Events>;
// Fallback: if a future `mitt` ships as `"type": "module"`, the namespace
// itself becomes callable and `.default` disappears. Cover both shapes.
const mittNamespace = mittNs as unknown as {
  default?: MittFactory;
} & MittFactory;
const mitt: MittFactory = mittNamespace.default ?? mittNamespace;

import type { PipelineEvent } from '../pipeline/index.js';

export interface BusMessage {
  /** e.g. `run:${run_id}`, `gate:pending`, or `*` for a global broadcast. */
  topic: string;
  event: PipelineEvent;
  /** ISO-8601 timestamp of bus emission, NOT event creation. */
  emitted_at: string;
}

/**
 * Filter syntax:
 *  - Comma-separated list of topic patterns (whitespace around commas trimmed).
 *  - `*` anywhere in the list matches all messages.
 *  - Otherwise each entry is matched against the message topic by exact equality.
 *  - An empty filter (`''` or `','`) matches NOTHING (safer default).
 *
 * Examples:
 *   '*'                       -> matches every message
 *   'run:abc'                 -> only messages whose topic === 'run:abc'
 *   'run:abc, gate:pending'   -> matches either
 *   ''                        -> matches nothing
 */
export function topicMatches(filter: string, topic: string): boolean {
  const patterns = filter
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (patterns.length === 0) return false;
  for (const p of patterns) {
    if (p === '*') return true;
    if (p === topic) return true;
  }
  return false;
}

/** Internal mitt event map: a single channel that fans out every BusMessage. */
type Events = {
  message: BusMessage;
};

/** Options for `EventBus.asyncIterable`. */
export interface AsyncIterableOpts {
  /** Maximum queued messages before drop-oldest kicks in. Default 1000. */
  maxQueueSize?: number;
}

export class EventBus {
  private readonly emitter: Emitter<Events> = mitt<Events>();
  private count = 0;

  /** Synchronously deliver `message` to every matching subscriber. */
  publish(message: BusMessage): void {
    this.emitter.emit('message', message);
  }

  /**
   * Subscribe with a topic filter. Returns an unsubscribe function. The
   * handler must not throw; if it does, the error is logged and other
   * subscribers continue to receive the message.
   */
  subscribe(filter: string, handler: (msg: BusMessage) => void): () => void {
    const wrapped = (msg: BusMessage): void => {
      if (!topicMatches(filter, msg.topic)) return;
      try {
        handler(msg);
      } catch (err) {
        // Subscribers are not allowed to break the bus. Log and move on.
        console.error('[EventBus] subscriber threw:', err);
      }
    };
    this.emitter.on('message', wrapped);
    this.count += 1;
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.emitter.off('message', wrapped);
      this.count -= 1;
    };
  }

  /**
   * Turn the bus into an AsyncIterable for the given filter.
   *
   * Backpressure: messages are queued; if the queue grows past
   * `maxQueueSize` the OLDEST queued message is dropped (the just-arrived
   * message wins). On iteration completion (`break`, `return`, or a thrown
   * error inside the consumer) the iterator's `return()` runs and
   * auto-unsubscribes from the bus.
   */
  asyncIterable(
    filter: string,
    opts?: AsyncIterableOpts,
  ): AsyncIterable<BusMessage> {
    const maxQueueSize = opts?.maxQueueSize ?? 1000;
    const subscribe = this.subscribe.bind(this);

    return {
      [Symbol.asyncIterator](): AsyncIterator<BusMessage> {
        const queue: BusMessage[] = [];
        let pendingResolve: ((r: IteratorResult<BusMessage>) => void) | null =
          null;
        let done = false;

        const unsub = subscribe(filter, (msg) => {
          if (done) return;
          if (pendingResolve !== null) {
            // A `next()` is awaiting; satisfy it directly.
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve({ value: msg, done: false });
            return;
          }
          // Drop-oldest backpressure.
          if (queue.length >= maxQueueSize) {
            queue.shift();
          }
          queue.push(msg);
        });

        const finish = (): IteratorResult<BusMessage> => {
          if (!done) {
            done = true;
            unsub();
            queue.length = 0;
            if (pendingResolve !== null) {
              const resolve = pendingResolve;
              pendingResolve = null;
              resolve({ value: undefined, done: true });
            }
          }
          return { value: undefined, done: true };
        };

        return {
          next(): Promise<IteratorResult<BusMessage>> {
            if (done) {
              return Promise.resolve({ value: undefined, done: true });
            }
            if (queue.length > 0) {
              // noUncheckedIndexedAccess: shift() returns T | undefined.
              const next = queue.shift() as BusMessage;
              return Promise.resolve({ value: next, done: false });
            }
            return new Promise<IteratorResult<BusMessage>>((resolve) => {
              pendingResolve = resolve;
            });
          },
          return(): Promise<IteratorResult<BusMessage>> {
            return Promise.resolve(finish());
          },
          throw(err: unknown): Promise<IteratorResult<BusMessage>> {
            finish();
            return Promise.reject(err);
          },
        };
      },
    };
  }

  /** Number of currently active subscribers (diagnostics / tests). */
  subscriberCount(): number {
    return this.count;
  }
}
