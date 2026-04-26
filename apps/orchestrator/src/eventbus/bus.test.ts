import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { PipelineEvent } from '../pipeline/index.js';
import { EventBus, topicMatches, type BusMessage } from './bus.js';

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

describe('topicMatches', () => {
  it('exact match', () => {
    expect(topicMatches('run:abc', 'run:abc')).toBe(true);
    expect(topicMatches('run:abc', 'run:xyz')).toBe(false);
  });

  it('wildcard matches everything', () => {
    expect(topicMatches('*', 'anything')).toBe(true);
    expect(topicMatches('*', 'run:42')).toBe(true);
  });

  it('comma-separated list with whitespace', () => {
    expect(topicMatches('run:a, gate:pending', 'run:a')).toBe(true);
    expect(topicMatches('run:a, gate:pending', 'gate:pending')).toBe(true);
    expect(topicMatches('run:a, gate:pending', 'run:b')).toBe(false);
  });

  it('wildcard mixed in list still matches all', () => {
    expect(topicMatches('run:a,*', 'unrelated')).toBe(true);
  });

  it('empty filter matches nothing', () => {
    expect(topicMatches('', 'anything')).toBe(false);
    expect(topicMatches(',', 'anything')).toBe(false);
    expect(topicMatches('   ', 'anything')).toBe(false);
  });
});

describe('EventBus.subscribe / publish', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('delivers messages with an exact filter', () => {
    const received: BusMessage[] = [];
    bus.subscribe('run:abc', (m) => received.push(m));

    bus.publish(makeMessage('run:abc', 'abc'));
    bus.publish(makeMessage('run:other', 'other'));

    expect(received).toHaveLength(1);
    expect(received[0]?.event.run_id).toBe('abc');
  });

  it('"*" filter receives every message', () => {
    const received: BusMessage[] = [];
    bus.subscribe('*', (m) => received.push(m));

    bus.publish(makeMessage('run:a'));
    bus.publish(makeMessage('gate:pending'));
    bus.publish(makeMessage('run:b'));

    expect(received).toHaveLength(3);
  });

  it('comma-separated filter matches any listed topic', () => {
    const received: BusMessage[] = [];
    bus.subscribe('run:a, gate:pending', (m) => received.push(m));

    bus.publish(makeMessage('run:a'));
    bus.publish(makeMessage('run:b'));
    bus.publish(makeMessage('gate:pending'));

    expect(received.map((m) => m.topic)).toEqual([
      'run:a',
      'gate:pending',
    ]);
  });

  it('unsubscribe removes the listener', () => {
    const received: BusMessage[] = [];
    const off = bus.subscribe('*', (m) => received.push(m));

    bus.publish(makeMessage('run:a'));
    expect(received).toHaveLength(1);
    expect(bus.subscriberCount()).toBe(1);

    off();
    expect(bus.subscriberCount()).toBe(0);

    bus.publish(makeMessage('run:b'));
    expect(received).toHaveLength(1);
  });

  it('unsubscribe is idempotent', () => {
    const off = bus.subscribe('*', () => {});
    expect(bus.subscriberCount()).toBe(1);
    off();
    off();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('a throwing subscriber does not break siblings', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const received: BusMessage[] = [];

    bus.subscribe('*', () => {
      throw new Error('boom');
    });
    bus.subscribe('*', (m) => received.push(m));

    bus.publish(makeMessage('run:a'));

    expect(received).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('EventBus.asyncIterable', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('yields published messages in order and filters by topic', async () => {
    const iter = bus.asyncIterable('run:a');
    const iterator = iter[Symbol.asyncIterator]();

    // Subscription is established when [Symbol.asyncIterator]() is called;
    // messages must be published AFTER that to be captured.
    bus.publish(makeMessage('run:a', 'first'));
    bus.publish(makeMessage('run:b', 'skip'));
    bus.publish(makeMessage('run:a', 'second'));

    const collected: string[] = [];
    while (collected.length < 2) {
      const r = await iterator.next();
      if (r.done) break;
      collected.push(r.value.event.run_id);
    }
    await iterator.return?.();

    expect(collected).toEqual(['first', 'second']);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('for-await break auto-unsubscribes', async () => {
    const iter = bus.asyncIterable('*');

    // Drive the for-await loop concurrently with the publishes so the loop
    // is actively iterating (and therefore subscribed) when events arrive.
    const consumerDone = (async (): Promise<number> => {
      let n = 0;
      for await (const _ of iter) {
        void _;
        n += 1;
        if (n === 2) break;
      }
      return n;
    })();

    // Wait until the consumer has subscribed before publishing. The
    // `for await` loop's [Symbol.asyncIterator]() and first .next() run on
    // the microtask queue; poll until subscriberCount > 0 (with a hard cap).
    for (let i = 0; i < 50 && bus.subscriberCount() === 0; i++) {
      await Promise.resolve();
    }
    expect(bus.subscriberCount()).toBe(1);

    bus.publish(makeMessage('run:a'));
    bus.publish(makeMessage('run:a'));
    // Extra publish that should be ignored after break.
    bus.publish(makeMessage('run:a'));

    const total = await consumerDone;
    expect(total).toBe(2);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('awaits a future publish', async () => {
    const iter = bus.asyncIterable('*');
    const iterator = iter[Symbol.asyncIterator]();

    const nextPromise = iterator.next();
    bus.publish(makeMessage('run:a'));

    const result = await nextPromise;
    expect(result.done).toBe(false);
    expect(result.value.topic).toBe('run:a');

    await iterator.return?.();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('drops oldest under maxQueueSize backpressure', async () => {
    const iter = bus.asyncIterable('*', { maxQueueSize: 2 });
    const iterator = iter[Symbol.asyncIterator]();

    // Three publishes with no consumer -> queue overflows by 1, oldest drops.
    bus.publish(makeMessage('run:a', 'A'));
    bus.publish(makeMessage('run:a', 'B'));
    bus.publish(makeMessage('run:a', 'C'));

    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value?.event.run_id).toBe('B');
    expect(second.value?.event.run_id).toBe('C');

    await iterator.return?.();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('return() resolves a pending next() with done', async () => {
    const iter = bus.asyncIterable('*');
    const iterator = iter[Symbol.asyncIterator]();

    const pending = iterator.next();
    const closed = await iterator.return?.();
    expect(closed?.done).toBe(true);

    const done = await pending;
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
    expect(bus.subscriberCount()).toBe(0);
  });
});
