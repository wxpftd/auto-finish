/**
 * Tiny zod-based validators for Hono handlers.
 *
 * `@hono/zod-validator` is intentionally not in the dependency tree; we use
 * these helpers inline in handlers. They return `{ ok: true, data }` on
 * success and `{ ok: false, response }` on failure, where `response` is a
 * 400 JSON Response ready to return.
 *
 * All validation errors are surfaced as a flat list of `{ path, message }` so
 * the dashboard / CLI can highlight specific fields.
 */

import type { Context } from 'hono';
import type { ZodError, ZodTypeAny, infer as ZodInfer } from 'zod';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationErrorBody {
  error: 'validation_failed';
  issues: ValidationIssue[];
}

function flattenZodError(err: ZodError): ValidationIssue[] {
  return err.issues.map((issue) => ({
    path: issue.path.length === 0 ? '<root>' : issue.path.join('.'),
    message: issue.message,
  }));
}

function buildErrorBody(err: ZodError): ValidationErrorBody {
  return { error: 'validation_failed', issues: flattenZodError(err) };
}

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

/**
 * Parse the request JSON body against the given zod schema. On success,
 * returns `{ ok: true, data }` where `data` is the parsed value. On failure
 * (bad JSON or schema mismatch), returns `{ ok: false, response }` — the
 * caller should `return result.response`.
 */
export async function validateJson<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<ValidationResult<ZodInfer<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    const response = c.json(
      {
        error: 'validation_failed',
        issues: [{ path: '<body>', message: 'invalid JSON body' }],
      } satisfies ValidationErrorBody,
      400,
    );
    return { ok: false, response };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const response = c.json(buildErrorBody(parsed.error), 400);
    return { ok: false, response };
  }
  return { ok: true, data: parsed.data as ZodInfer<S> };
}

/**
 * Parse query parameters against the given schema. Hono returns query strings
 * as `Record<string, string>`; coercion (string → number, etc.) is the
 * caller's responsibility via zod transforms.
 */
export function validateQuery<S extends ZodTypeAny>(
  c: Context,
  schema: S,
): ValidationResult<ZodInfer<S>> {
  const raw = c.req.query();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const response = c.json(buildErrorBody(parsed.error), 400);
    return { ok: false, response };
  }
  return { ok: true, data: parsed.data as ZodInfer<S> };
}
