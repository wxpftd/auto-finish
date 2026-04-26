import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStream } from './stream-parser.js';
import type {
  AssistantEvent,
  ClaudeStreamEvent,
  ToolResultBlock,
  ToolUseBlock,
  UserEvent,
} from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '__fixtures__');

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), 'utf8');
}

async function* fromString(text: string): AsyncIterable<string> {
  yield text;
}

async function* fromChunks(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

async function* fromBytes(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function collect(
  it: AsyncIterable<ClaudeStreamEvent>,
): Promise<ClaudeStreamEvent[]> {
  const out: ClaudeStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('parseStream — simple-pong fixture (real capture)', () => {
  it('parses every line, produces a result event last, and contains expected types', async () => {
    const text = await loadFixture('simple-pong.jsonl');
    const events = await collect(parseStream(fromString(text)));

    // Sanity: more than a handful of events.
    expect(events.length).toBeGreaterThan(3);

    // No parse errors on a real capture.
    const parseErrors = events.filter((e) => e.type === 'parse_error');
    expect(parseErrors).toEqual([]);

    // Last event is `result`.
    const last = events.at(-1);
    expect(last?.type).toBe('result');

    // Order assertion (positions-agnostic but ordering-sensitive): the first
    // `system:init` precedes the first `assistant`, which precedes the
    // terminal `result`.
    const firstInitIdx = events.findIndex(
      (e) => e.type === 'system' && (e as { subtype?: string }).subtype === 'init',
    );
    const firstAssistantIdx = events.findIndex((e) => e.type === 'assistant');
    const firstResultIdx = events.findIndex((e) => e.type === 'result');

    expect(firstInitIdx).toBeGreaterThanOrEqual(0);
    expect(firstAssistantIdx).toBeGreaterThan(firstInitIdx);
    expect(firstResultIdx).toBeGreaterThan(firstAssistantIdx);
  });
});

describe('parseStream — tool-use fixture (real capture)', () => {
  it('contains an assistant tool_use block and a user tool_result block, paired by id', async () => {
    const text = await loadFixture('tool-use-echo.jsonl');
    const events = await collect(parseStream(fromString(text)));

    expect(events.filter((e) => e.type === 'parse_error')).toEqual([]);

    const assistantToolUses: { event: AssistantEvent; block: ToolUseBlock }[] = [];
    for (const e of events) {
      if (e.type !== 'assistant') continue;
      const ae = e as AssistantEvent;
      for (const block of ae.message.content) {
        if (block.type === 'tool_use') {
          assistantToolUses.push({ event: ae, block: block as ToolUseBlock });
        }
      }
    }
    expect(assistantToolUses.length).toBeGreaterThanOrEqual(1);

    const userToolResults: ToolResultBlock[] = [];
    for (const e of events) {
      if (e.type !== 'user') continue;
      const ue = e as UserEvent;
      for (const block of ue.message.content) {
        if (block.type === 'tool_result') {
          userToolResults.push(block as ToolResultBlock);
        }
      }
    }
    expect(userToolResults.length).toBeGreaterThanOrEqual(1);

    // The tool_result references the prior tool_use id.
    const firstUse = assistantToolUses[0]?.block;
    expect(firstUse).toBeDefined();
    const matched = userToolResults.find((r) => r.tool_use_id === firstUse?.id);
    expect(matched).toBeDefined();
  });
});

describe('parseStream — chunk handling', () => {
  it('handles a stream split mid-JSON-line correctly', async () => {
    const obj1 = { type: 'system', subtype: 'init', session_id: 'abc' };
    const obj2 = {
      type: 'assistant',
      session_id: 'abc',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    };
    const fullLine1 = JSON.stringify(obj1) + '\n';
    const fullLine2 = JSON.stringify(obj2) + '\n';

    // Splice mid-key, mid-value, and across the newline boundary.
    const fused = fullLine1 + fullLine2;
    const splitA = fused.slice(0, 5);
    const splitB = fused.slice(5, 25);
    const splitC = fused.slice(25, fullLine1.length + 10);
    const splitD = fused.slice(fullLine1.length + 10);

    const events = await collect(
      parseStream(fromChunks(splitA, splitB, splitC, splitD)),
    );

    expect(events.filter((e) => e.type === 'parse_error')).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('system');
    expect(events[1]?.type).toBe('assistant');
  });

  it('flushes the trailing line when the stream does not end with a newline', async () => {
    const obj = { type: 'system', subtype: 'init', session_id: 'no-newline' };
    const text = JSON.stringify(obj); // no trailing \n
    const events = await collect(parseStream(fromString(text)));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('system');
  });

  it('ignores blank lines', async () => {
    const obj = { type: 'system', subtype: 'init' };
    const text = '\n\n' + JSON.stringify(obj) + '\n\n';
    const events = await collect(parseStream(fromString(text)));
    expect(events).toHaveLength(1);
  });

  it('decodes UTF-8 byte chunks correctly even when split inside a multi-byte sequence', async () => {
    // "héllo" — 'é' is 0xC3 0xA9 in UTF-8.
    const obj = { type: 'system', subtype: 'init', note: 'héllo 🌟' };
    const fullLine = JSON.stringify(obj) + '\n';
    const bytes = new TextEncoder().encode(fullLine);

    // Split mid-multi-byte sequence at position 1 of the way through.
    // We just split somewhere inside the buffer; UTF-8 decoder with stream:true
    // must hold the partial bytes until the next chunk.
    const mid = Math.floor(bytes.length / 2);
    const chunkA = bytes.slice(0, mid);
    const chunkB = bytes.slice(mid);

    const events = await collect(parseStream(fromBytes(chunkA, chunkB)));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('system');
    const note = (events[0] as { note?: string }).note;
    expect(note).toBe('héllo 🌟');
  });
});

describe('parseStream — error handling', () => {
  it('emits parse_error for a malformed JSON line and keeps parsing afterwards', async () => {
    const valid1 = JSON.stringify({ type: 'system', subtype: 'init' });
    const malformed = '{not json at all';
    const valid2 = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      session_id: 'x',
      result: 'done',
    });
    const text = `${valid1}\n${malformed}\n${valid2}\n`;

    const events = await collect(parseStream(fromString(text)));
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe('system');
    expect(events[1]?.type).toBe('parse_error');
    expect((events[1] as { raw?: string }).raw).toBe(malformed);
    expect((events[1] as { error?: string }).error).toMatch(/JSON|Unexpected|expected/i);
    expect(events[2]?.type).toBe('result');
  });

  it('emits parse_error for a JSON object that violates the schema', async () => {
    // `assistant` events must have `message.content` as an array; missing it
    // should fail schema validation.
    const bogus = JSON.stringify({ type: 'assistant', message: { role: 'assistant' } });
    const events = await collect(parseStream(fromString(bogus + '\n')));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('parse_error');
  });

  it('passes through unknown top-level event types via the permissive fallback', async () => {
    // Events that have a `type` string but aren't one of our named variants
    // should still flow through (e.g., new event types added by Anthropic).
    const obj = JSON.stringify({ type: 'some_future_event', payload: { a: 1 } });
    const events = await collect(parseStream(fromString(obj + '\n')));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('some_future_event');
  });
});
