import {
  AssistantEventSchema,
  ResultEventSchema,
  StreamPartialEventSchema,
  SystemEventSchema,
  UnknownEventSchema,
  RateLimitEventSchema,
  UserEventSchema,
} from './schema.js';
import type { ClaudeStreamEvent, ParseErrorEvent } from './schema.js';
import type { ZodTypeAny } from 'zod';

/**
 * Map of `type` discriminator values we recognize to their strict schemas.
 * Anything not in this map flows through the permissive fallback so future
 * Anthropic event types don't break the parser. Anything *in* this map but
 * with a malformed body produces a `parse_error` — we need these events to
 * have the shape we depend on.
 */
const KNOWN_TYPE_SCHEMAS: Record<string, ZodTypeAny> = {
  system: SystemEventSchema,
  assistant: AssistantEventSchema,
  user: UserEventSchema,
  result: ResultEventSchema,
  stream_event: StreamPartialEventSchema,
  rate_limit_event: RateLimitEventSchema,
};

/**
 * Input the parser accepts:
 * - `AsyncIterable<string>`: pre-decoded text chunks.
 * - `AsyncIterable<Uint8Array>`: byte chunks (we decode UTF-8 streamingly).
 * - Node's `Readable` (which is itself an AsyncIterable of `Buffer | string`).
 */
export type StreamParserInput =
  | AsyncIterable<string>
  | AsyncIterable<Uint8Array>
  | NodeJS.ReadableStream;

/**
 * Parses a Claude Code CLI `--output-format stream-json` stream.
 *
 * Behavior:
 * - Splits on `\n` newlines, buffering partial lines across chunk boundaries.
 * - Decodes byte chunks as UTF-8 streamingly (multi-byte sequences split
 *   across chunks are handled correctly).
 * - Flushes the final buffered line if the stream ends without a trailing
 *   newline.
 * - On a malformed line (bad JSON or schema violation), yields a synthetic
 *   `parse_error` event and continues parsing — never throws on bad input.
 */
export async function* parseStream(
  input: StreamParserInput,
): AsyncIterable<ClaudeStreamEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const iterator = toAsyncIterable(input);

  for await (const chunk of iterator) {
    let text: string;
    if (typeof chunk === 'string') {
      text = chunk;
    } else if (chunk instanceof Uint8Array) {
      // Buffer is a Uint8Array on Node, so this branch covers Buffer too.
      text = decoder.decode(chunk, { stream: true });
    } else {
      // Defensive: stringify anything else (shouldn't happen with typed inputs).
      text = String(chunk);
    }

    buffer += text;

    // Drain complete lines from the buffer.
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const event = parseLine(line);
      if (event !== null) yield event;
    }
  }

  // Flush decoder state (handles a final partial multi-byte sequence — should
  // emit empty for valid UTF-8 but we append it anyway for completeness).
  buffer += decoder.decode();

  // Flush trailing line if the stream didn't end with a newline.
  if (buffer.length > 0) {
    const event = parseLine(buffer);
    if (event !== null) yield event;
  }
}

/**
 * Parse a single line of stream-json output.
 *
 * Returns:
 * - `null` for blank lines (we silently skip them — the CLI emits a trailing
 *   blank in some cases).
 * - A validated `ClaudeStreamEvent` when the line is good JSON + matches a
 *   known schema variant (or our permissive fallback).
 * - A synthetic `parse_error` event for malformed JSON or schema misses.
 */
function parseLine(rawLine: string): ClaudeStreamEvent | null {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) return null;

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return makeParseError(trimmed, err);
  }

  // Dispatch on the `type` discriminator. Strict-validate known types so that
  // shape changes Anthropic makes to events we *depend on* are surfaced as
  // parse errors rather than silently coerced. Unknown types pass through.
  const typeField =
    typeof json === 'object' && json !== null && 'type' in json
      ? (json as { type: unknown }).type
      : undefined;

  if (typeof typeField !== 'string') {
    return makeParseError(trimmed, 'event missing string `type` field');
  }

  const knownSchema = KNOWN_TYPE_SCHEMAS[typeField];
  if (knownSchema) {
    const result = knownSchema.safeParse(json);
    if (!result.success) return makeParseError(trimmed, result.error);
    return result.data as ClaudeStreamEvent;
  }

  const unknown = UnknownEventSchema.safeParse(json);
  if (!unknown.success) return makeParseError(trimmed, unknown.error);
  return unknown.data;
}

function makeParseError(raw: string, err: unknown): ParseErrorEvent {
  const message = err instanceof Error ? err.message : String(err);
  return { type: 'parse_error', raw, error: message };
}

/**
 * Normalize the various input shapes into a single async iterable. Node
 * `Readable` already implements `Symbol.asyncIterator`, so we just check for
 * its presence rather than depending on Node-specific types here.
 */
function toAsyncIterable(
  input: StreamParserInput,
): AsyncIterable<string | Uint8Array> {
  // AsyncIterable check: every supported input has Symbol.asyncIterator.
  const maybeIter = input as AsyncIterable<string | Uint8Array | Buffer>;
  if (typeof maybeIter[Symbol.asyncIterator] === 'function') {
    return maybeIter as AsyncIterable<string | Uint8Array>;
  }
  throw new TypeError(
    'parseStream input must be an AsyncIterable or Node Readable stream',
  );
}
