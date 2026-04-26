import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeStage } from './spawn.js';
import { FakeSession } from './__test-utils__/fake-session.js';
import type { ClaudeInvocation } from './argv.js';
import type { StreamEvent } from '../sandbox/interface.js';
import type { ClaudeStageEvent } from './stage-event.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '__fixtures__');

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), 'utf8');
}

/**
 * Build a sequence of StreamEvents that emits the fixture text in N stdout
 * chunks (split mid-line, so the parser's chunk-buffering is exercised),
 * then a single exit event with `code`.
 */
function streamEventsFromText(
  text: string,
  numChunks: number,
  exitCode: number,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const chunkSize = Math.ceil(text.length / numChunks);
  for (let i = 0; i < text.length; i += chunkSize) {
    events.push({ kind: 'stdout', data: text.slice(i, i + chunkSize) });
  }
  events.push({ kind: 'exit', code: exitCode });
  return events;
}

function makeInvocation(): ClaudeInvocation {
  // Real argv shape doesn't matter to the spawn coordinator (it just
  // forwards to startStream), but let's pass something realistic.
  return {
    argv: ['claude', '--print', '--output-format', 'stream-json', 'hi'],
    cwd: '/workspace',
  };
}

async function collect(
  it: AsyncGenerator<ClaudeStageEvent, void, void>,
): Promise<ClaudeStageEvent[]> {
  const out: ClaudeStageEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('runClaudeStage — simple-pong fixture', () => {
  it('emits session_init then assistant_text "pong" then finished with exit 0', async () => {
    const text = await loadFixture('simple-pong.jsonl');
    const session = new FakeSession({
      streamEvents: streamEventsFromText(text, 7, 0),
    });

    const events = await collect(
      runClaudeStage({ session, invocation: makeInvocation() }),
    );

    // First event: session_init.
    const first = events[0];
    expect(first?.kind).toBe('session_init');
    if (first?.kind === 'session_init') {
      expect(first.session_id).toBeTruthy();
      expect(first.model).toMatch(/claude/);
      expect(Array.isArray(first.tools)).toBe(true);
      expect(first.tools.length).toBeGreaterThan(0);
    }

    // Contains an assistant_text with the "pong" body.
    const texts = events.flatMap((e) =>
      e.kind === 'assistant_text' ? [e.text] : [],
    );
    expect(texts).toContain('pong');

    // Last event: finished with exit_code 0 and result-derived metadata.
    const last = events.at(-1);
    expect(last?.kind).toBe('finished');
    if (last?.kind === 'finished') {
      expect(last.exit_code).toBe(0);
      // The fixture has total_cost_usd, num_turns, duration_ms set.
      expect(typeof last.total_cost_usd).toBe('number');
      expect(typeof last.num_turns).toBe('number');
      expect(typeof last.duration_ms).toBe('number');
    }

    // No parse_error or failed events on a real capture.
    expect(events.filter((e) => e.kind === 'parse_error')).toEqual([]);
    expect(events.filter((e) => e.kind === 'failed')).toEqual([]);
  });

  it('forwards the invocation argv and cwd to session.startStream', async () => {
    const session = new FakeSession({
      streamEvents: [{ kind: 'exit', code: 0 }],
    });
    const inv = makeInvocation();
    await collect(runClaudeStage({ session, invocation: inv }));
    expect(session.streamArgvCalls).toEqual([inv.argv]);
  });
});

describe('runClaudeStage — tool-use-echo fixture', () => {
  it('emits at least one tool_use and one tool_result, paired by id, ending with finished', async () => {
    const text = await loadFixture('tool-use-echo.jsonl');
    const session = new FakeSession({
      streamEvents: streamEventsFromText(text, 9, 0),
    });

    const events = await collect(
      runClaudeStage({ session, invocation: makeInvocation() }),
    );

    const toolUses = events.flatMap((e) => (e.kind === 'tool_use' ? [e] : []));
    const toolResults = events.flatMap((e) =>
      e.kind === 'tool_result' ? [e] : [],
    );

    expect(toolUses.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    // First tool_use is the "Bash echo hello-world" call from the fixture.
    expect(toolUses[0]?.tool).toBe('Bash');
    expect(toolUses[0]?.id).toBeTruthy();

    // The first tool_result must reference the tool_use's id.
    const matching = toolResults.find(
      (r) => r.tool_use_id === toolUses[0]?.id,
    );
    expect(matching).toBeDefined();
    expect(matching?.is_error).toBe(false);
    expect(matching?.content).toContain('hello-world');

    // Last event: finished with exit 0.
    const last = events.at(-1);
    expect(last?.kind).toBe('finished');
    if (last?.kind === 'finished') {
      expect(last.exit_code).toBe(0);
    }

    expect(events.filter((e) => e.kind === 'parse_error')).toEqual([]);
    expect(events.filter((e) => e.kind === 'failed')).toEqual([]);
  });
});

describe('runClaudeStage — terminal events', () => {
  it('emits finished with the non-zero exit code from the sandbox', async () => {
    const session = new FakeSession({
      streamEvents: [
        { kind: 'stderr', data: 'fatal: bad request\n' },
        { kind: 'exit', code: 137 },
      ],
    });
    let captured = '';
    const events = await collect(
      runClaudeStage({
        session,
        invocation: makeInvocation(),
        stderrSink: (chunk) => {
          captured += chunk;
        },
      }),
    );

    expect(captured).toBe('fatal: bad request\n');
    const last = events.at(-1);
    expect(last).toEqual({ kind: 'finished', exit_code: 137 });
  });

  it('emits failed when the underlying stream ends without an exit event', async () => {
    // Only stdout, no exit — simulates a malformed sandbox impl.
    const session = new FakeSession({
      streamEvents: [{ kind: 'stdout', data: '' }],
    });
    const events = await collect(
      runClaudeStage({ session, invocation: makeInvocation() }),
    );
    const last = events.at(-1);
    expect(last?.kind).toBe('failed');
    if (last?.kind === 'failed') {
      expect(last.reason).toMatch(/exit/);
    }
  });

  it('emits failed when startStream throws mid-iteration (transport error)', async () => {
    // Yield a stdout chunk, then the underlying iterator throws — simulating
    // a sandbox transport hangup or a session destroyed in flight.
    const session = new FakeSession({
      streamEvents: [{ kind: 'stdout', data: '' }],
      streamThrowAfterEvents: new Error('session has been destroyed'),
    });
    const events = await collect(
      runClaudeStage({ session, invocation: makeInvocation() }),
    );
    const last = events.at(-1);
    expect(last?.kind).toBe('failed');
    if (last?.kind === 'failed') {
      expect(last.reason).toMatch(/destroyed/);
    }
  });

  it('forwards parser parse_error events through unchanged', async () => {
    // A malformed JSON line should trigger the parser's synthetic event.
    const malformed = '{not-json\n';
    const goodResult =
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5,
        num_turns: 1,
        result: 'ok',
        session_id: 'abc',
      }) + '\n';

    const session = new FakeSession({
      streamEvents: [
        { kind: 'stdout', data: malformed },
        { kind: 'stdout', data: goodResult },
        { kind: 'exit', code: 0 },
      ],
    });

    const events = await collect(
      runClaudeStage({ session, invocation: makeInvocation() }),
    );

    const parseErrors = events.filter((e) => e.kind === 'parse_error');
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toMatchObject({
      kind: 'parse_error',
      raw: '{not-json',
    });
    expect(events.at(-1)?.kind).toBe('finished');
  });
});
