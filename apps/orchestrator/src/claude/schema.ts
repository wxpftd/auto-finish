import { z } from 'zod';

/**
 * Zod schemas for Claude Code CLI `--output-format stream-json` events.
 *
 * Design:
 * - Permissive on unknown fields (`.passthrough()`) so future Anthropic
 *   additions don't break the orchestrator.
 * - Strict on the `type` discriminator and the few fields we depend on.
 * - We use `z.union` (not `z.discriminatedUnion`) of `.passthrough()` objects
 *   because composability of discriminatedUnion with passthrough is brittle in
 *   zod 3.x and we want forward-compat above all.
 */

// ---------- Inner content blocks ----------

const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const ThinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string().optional(),
  })
  .passthrough();

const ToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown().optional(),
  })
  .passthrough();

const ToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

const AssistantContentBlockSchema = z.union([
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  // Forward-compatible: any other block shape with a `type` string.
  z.object({ type: z.string() }).passthrough(),
]);

const UserContentBlockSchema = z.union([
  TextBlockSchema,
  ToolResultBlockSchema,
  z.object({ type: z.string() }).passthrough(),
]);

// ---------- Top-level events ----------

/**
 * `system` events: init plus a variety of subtypes (e.g. `hook_started`,
 * `hook_response`). The init subtype carries session_id, model, tools list.
 * Other subtypes carry hook payloads we don't depend on. We accept any
 * subtype string and passthrough unknown fields.
 */
export const SystemEventSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.string(),
    session_id: z.string().optional(),
  })
  .passthrough();

export const AssistantEventSchema = z
  .object({
    type: z.literal('assistant'),
    session_id: z.string().optional(),
    parent_tool_use_id: z.string().nullable().optional(),
    message: z
      .object({
        id: z.string().optional(),
        role: z.literal('assistant').optional(),
        model: z.string().optional(),
        content: z.array(AssistantContentBlockSchema),
      })
      .passthrough(),
  })
  .passthrough();

export const UserEventSchema = z
  .object({
    type: z.literal('user'),
    session_id: z.string().optional(),
    parent_tool_use_id: z.string().nullable().optional(),
    message: z
      .object({
        role: z.literal('user').optional(),
        content: z.array(UserContentBlockSchema),
      })
      .passthrough(),
  })
  .passthrough();

export const ResultEventSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    duration_ms: z.number().optional(),
    duration_api_ms: z.number().optional(),
    num_turns: z.number().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    stop_reason: z.string().nullable().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

/**
 * Emitted only when `--include-partial-messages` is on. Wraps the SSE-style
 * Anthropic streaming event under `event`.
 */
export const StreamPartialEventSchema = z
  .object({
    type: z.literal('stream_event'),
    session_id: z.string().optional(),
    event: z
      .object({
        type: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Surprise event seen in real captures: not in the documented schema but
 * emitted by the CLI between assistant and result. We accept it permissively
 * so it doesn't trigger parse errors.
 */
export const RateLimitEventSchema = z
  .object({
    type: z.literal('rate_limit_event'),
    session_id: z.string().optional(),
    rate_limit_info: z.unknown().optional(),
  })
  .passthrough();

/**
 * Synthetic event produced by the parser (NOT from the CLI) when a line
 * cannot be parsed as JSON or fails schema validation. Lets the orchestrator
 * decide whether to log/abort/continue rather than throwing.
 */
export const ParseErrorEventSchema = z.object({
  type: z.literal('parse_error'),
  raw: z.string(),
  error: z.string(),
});

/**
 * Catch-all for unknown top-level event types we haven't seen yet. We keep
 * the original payload around under `raw` for forensic logging without
 * losing data.
 */
export const UnknownEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export const ClaudeStreamEventSchema = z.union([
  SystemEventSchema,
  AssistantEventSchema,
  UserEventSchema,
  ResultEventSchema,
  StreamPartialEventSchema,
  RateLimitEventSchema,
  ParseErrorEventSchema,
  // Final fallback: any object with a string `type` field. Keeps unknown
  // future event types flowing through instead of dropping them.
  UnknownEventSchema,
]);

// ---------- Inferred types ----------

export type SystemEvent = z.infer<typeof SystemEventSchema>;
export type AssistantEvent = z.infer<typeof AssistantEventSchema>;
export type UserEvent = z.infer<typeof UserEventSchema>;
export type ResultEvent = z.infer<typeof ResultEventSchema>;
export type StreamPartialEvent = z.infer<typeof StreamPartialEventSchema>;
export type RateLimitEvent = z.infer<typeof RateLimitEventSchema>;
export type ParseErrorEvent = z.infer<typeof ParseErrorEventSchema>;
export type UnknownEvent = z.infer<typeof UnknownEventSchema>;
export type ClaudeStreamEvent = z.infer<typeof ClaudeStreamEventSchema>;

export type AssistantContentBlock = z.infer<typeof AssistantContentBlockSchema>;
export type UserContentBlock = z.infer<typeof UserContentBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
