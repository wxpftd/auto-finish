/**
 * Spawn coordinator for the `claude` CLI inside a sandbox.
 *
 * `runClaudeStage` is the only public entry point: it takes a SandboxSession
 * and a fully-built ClaudeInvocation, drives `session.startStream`, parses
 * stdout via `parseStream`, and yields a typed sequence of
 * {@link ClaudeStageEvent}s. The pipeline runner is the consumer.
 *
 * Coordination model:
 * - `session.startStream` yields `{kind:'stdout'|'stderr'|'exit'}`.
 * - `parseStream` wants an `AsyncIterable<string>` of stdout text only.
 * - We use an internal AsyncQueue to bridge the two: a background pump
 *   reads from `startStream`, pushes stdout strings onto the queue, accumulates
 *   stderr (logged as a single chunk on exit), and remembers the exit code.
 *   Once startStream emits `exit`, the queue is closed; the consumer's
 *   `for await ... of parseStream(queue)` then drains naturally.
 * - After parse drain, we emit `finished` with the exit code + carried fields
 *   from the last `result` event (cost/turns/duration/usage).
 */

import type { SandboxSession, StreamEvent } from '../sandbox/interface.js';
import type { ClaudeInvocation } from './argv.js';
import { parseStream } from './stream-parser.js';
import type {
  AssistantContentBlock,
  AssistantEvent,
  ClaudeStreamEvent,
  ParseErrorEvent,
  ResultEvent,
  RateLimitEvent,
  SystemEvent,
  ToolResultBlock,
  UserEvent,
} from './schema.js';
import type { ClaudeStageEvent } from './stage-event.js';

export interface RunClaudeStageArgs {
  session: SandboxSession;
  invocation: ClaudeInvocation;
  /** Optional stderr sink for diagnostic logging. Defaults to console.error. */
  stderrSink?: (chunk: string) => void;
}

/**
 * Drive the claude CLI to completion, yielding typed stage events.
 *
 * Behavior contract:
 * - Always yields exactly one terminal event: `finished` (on clean exit, any
 *   exit code) or `failed` (unrecoverable session error).
 * - Stderr from the CLI is forwarded to `stderrSink` but does not affect
 *   the event sequence.
 * - parse_error events from the parser are forwarded as-is.
 * - If the consumer breaks early, the underlying `startStream` iterator's
 *   try/finally cleans up the subprocess.
 */
export async function* runClaudeStage(
  args: RunClaudeStageArgs,
): AsyncGenerator<ClaudeStageEvent, void, void> {
  const stderrSink = args.stderrSink ?? ((chunk: string) => process.stderr.write(chunk));

  const queue = new AsyncQueue<string>();
  let exitCode: number | undefined;
  let pumpError: Error | undefined;

  // Background pump: reads StreamEvents, splits into stdout/stderr/exit,
  // closes the queue when the underlying stream ends.
  const pump = (async () => {
    try {
      for await (const ev of args.session.startStream(args.invocation.argv, {
        cwd: args.invocation.cwd,
        env: args.invocation.env,
      })) {
        handleStreamEvent(ev);
      }
    } catch (err) {
      pumpError = err instanceof Error ? err : new Error(String(err));
    } finally {
      queue.close();
    }
  })();

  function handleStreamEvent(ev: StreamEvent): void {
    if (ev.kind === 'stdout') {
      queue.push(ev.data);
    } else if (ev.kind === 'stderr') {
      stderrSink(ev.data);
    } else {
      // ev.kind === 'exit'
      exitCode = ev.code;
    }
  }

  // Carry-through state from the result event so we can attach it to `finished`.
  let lastResult: ResultEvent | undefined;

  try {
    for await (const raw of parseStream(queue)) {
      yield* translate(raw, (r) => {
        lastResult = r;
      });
    }
  } catch (err) {
    // parseStream itself shouldn't throw on bad input (it emits parse_error
    // synthetic events), but a broken upstream queue or unexpected runtime
    // error should still surface as a failed event rather than a thrown
    // generator.
    const reason = err instanceof Error ? err.message : String(err);
    yield { kind: 'failed', reason };
    await pump.catch(() => undefined);
    return;
  }

  // Make sure the pump has fully settled (so `exitCode` and `pumpError` are
  // final by the time we emit the terminal event).
  await pump;

  if (pumpError !== undefined) {
    yield { kind: 'failed', reason: pumpError.message };
    return;
  }

  // Build the terminal `finished` event. Exit code is required; if the
  // sandbox didn't emit one (shouldn't happen — interface mandates exactly
  // one exit event), we treat that as a failure.
  if (exitCode === undefined) {
    yield {
      kind: 'failed',
      reason: 'sandbox stream ended without an exit event',
    };
    return;
  }

  const finished: ClaudeStageEvent = {
    kind: 'finished',
    exit_code: exitCode,
  };
  if (lastResult !== undefined) {
    if (lastResult.total_cost_usd !== undefined) {
      finished.total_cost_usd = lastResult.total_cost_usd;
    }
    if (lastResult.num_turns !== undefined) {
      finished.num_turns = lastResult.num_turns;
    }
    if (lastResult.duration_ms !== undefined) {
      finished.duration_ms = lastResult.duration_ms;
    }
    if (lastResult.usage !== undefined) {
      finished.usage = lastResult.usage;
    }
  }
  yield finished;
}

/**
 * Translate a single raw `ClaudeStreamEvent` into 0+ stage events.
 *
 * Generators all the way down: a single assistant message can carry multiple
 * content blocks (e.g. thinking + tool_use), each producing its own stage
 * event. We skip thinking blocks — they're not actionable for the dashboard.
 */
function* translate(
  raw: ClaudeStreamEvent,
  onResult: (r: ResultEvent) => void,
): Generator<ClaudeStageEvent, void, void> {
  switch (raw.type) {
    case 'system': {
      // Only `system:init` carries session-level metadata; other subtypes
      // (hook_started, hook_response, etc.) are noise for stage events.
      const sys = raw as SystemEvent;
      if (sys.subtype !== 'init') return;
      const init = extractInit(sys);
      if (init) yield init;
      return;
    }
    case 'assistant': {
      const ae = raw as AssistantEvent;
      for (const block of ae.message.content) {
        const ev = translateAssistantBlock(block);
        if (ev) yield ev;
      }
      return;
    }
    case 'user': {
      // User events typically wrap tool_result blocks (echoed back to the
      // model). We surface those for dashboard rendering.
      const ue = raw as UserEvent;
      for (const block of ue.message.content) {
        if (block.type === 'tool_result') {
          yield translateToolResult(block as ToolResultBlock);
        }
      }
      return;
    }
    case 'rate_limit_event': {
      const rl = raw as RateLimitEvent;
      const resetAt = extractRateLimitReset(rl);
      const ev: ClaudeStageEvent = { kind: 'rate_limited' };
      if (resetAt !== undefined) ev.reset_at = resetAt;
      yield ev;
      return;
    }
    case 'result': {
      // Stash for the terminal `finished` event; do not yield as a stage event.
      onResult(raw as ResultEvent);
      return;
    }
    case 'parse_error': {
      // ClaudeStreamEvent is a zod union of mostly-passthrough variants; the
      // `type` narrow alone doesn't pin the inferred shape to ParseErrorEvent.
      const pe = raw as ParseErrorEvent;
      yield {
        kind: 'parse_error',
        raw: pe.raw,
        error: pe.error,
      };
      return;
    }
    case 'stream_event':
      // Partial SSE-style events (--include-partial-messages); we only act on
      // the consolidated assistant/user/result events. Drop these silently
      // for now — future work can surface incremental text deltas if we want
      // a typing-style dashboard.
      return;
    default:
      // Unknown / passthrough event — ignore.
      return;
  }
}

/**
 * Pull `model` and `tools` out of a system:init event without `as any`.
 *
 * `SystemEventSchema` is `.passthrough()` so these fields exist at runtime
 * but aren't on the inferred type. We narrow via `unknown` casts and runtime
 * checks.
 */
function extractInit(
  ev: SystemEvent,
): Extract<ClaudeStageEvent, { kind: 'session_init' }> | undefined {
  const payload = ev as unknown as {
    session_id?: unknown;
    model?: unknown;
    tools?: unknown;
  };
  const sessionId =
    typeof payload.session_id === 'string' ? payload.session_id : undefined;
  const model = typeof payload.model === 'string' ? payload.model : undefined;
  const tools =
    Array.isArray(payload.tools) &&
    payload.tools.every((t): t is string => typeof t === 'string')
      ? payload.tools
      : undefined;

  if (sessionId === undefined || model === undefined || tools === undefined) {
    return undefined;
  }
  return {
    kind: 'session_init',
    session_id: sessionId,
    model,
    tools,
  };
}

function translateAssistantBlock(
  block: AssistantContentBlock,
): ClaudeStageEvent | undefined {
  if (block.type === 'text') {
    // The union includes a permissive fallback variant; narrow by `type`
    // alone doesn't pin TS to the strict TextBlock shape, so cast through
    // the schema-matching shape.
    const textBlock = block as { type: 'text'; text: string };
    return { kind: 'assistant_text', text: textBlock.text };
  }
  if (block.type === 'tool_use') {
    // Block matches ToolUseBlockSchema: { id, name, input? }.
    const toolUse = block as { id: string; name: string; input?: unknown };
    return {
      kind: 'tool_use',
      tool: toolUse.name,
      input: toolUse.input,
      id: toolUse.id,
    };
  }
  // `thinking` and any future block types are intentionally dropped.
  return undefined;
}

function translateToolResult(
  block: ToolResultBlock,
): Extract<ClaudeStageEvent, { kind: 'tool_result' }> {
  // ToolResultBlock.content is `unknown` — could be a string, an array of
  // content blocks, or even null. Stringify defensively so consumers always
  // get a string for logging / dashboard rendering.
  let content: string;
  if (typeof block.content === 'string') {
    content = block.content;
  } else if (block.content === undefined || block.content === null) {
    content = '';
  } else {
    try {
      content = JSON.stringify(block.content);
    } catch {
      content = String(block.content);
    }
  }
  return {
    kind: 'tool_result',
    tool_use_id: block.tool_use_id,
    content,
    is_error: block.is_error ?? false,
  };
}

function extractRateLimitReset(ev: RateLimitEvent): string | undefined {
  // Real captures show this field's exact path is undocumented; check a
  // couple of plausible locations and return undefined if absent.
  const payload = ev as unknown as {
    rate_limit_info?: { reset_at?: unknown; resetsAt?: unknown };
  };
  const info = payload.rate_limit_info;
  if (info === undefined || info === null) return undefined;
  if (typeof info.reset_at === 'string') return info.reset_at;
  if (typeof info.resetsAt === 'string') return info.resetsAt;
  return undefined;
}

// ---------- AsyncQueue ----------

/**
 * Single-consumer async queue with backpressure-free push semantics.
 *
 * Why we wrote our own:
 * - Need an explicit `close()` so `parseStream`'s `for await` ends cleanly.
 * - Need both push-when-no-waiter (buffer) and resolve-pending-waiter
 *   (handoff). Naive promise-chain implementations break the latter when a
 *   `next()` is awaited *before* the next `push()` arrives.
 *
 * Invariant: at any time, EITHER the buffer has items OR there is a pending
 * waiter — never both. `push` resolves a waiter if one exists, else buffers.
 * `next` returns the head of the buffer if any, else creates a new waiter.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  #buffer: T[] = [];
  #waiters: ((value: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return; // drop after close — caller misuse, but safe.
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.#buffer.push(value);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Resolve any pending waiters with `done: true` so consumers exit their
    // `for await` loop.
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      // value typed as T but `done: true` discards it per IteratorResult spec;
      // we use `undefined as unknown as T` to avoid `any`.
      waiter?.({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#buffer.length > 0) {
          const value = this.#buffer.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}
