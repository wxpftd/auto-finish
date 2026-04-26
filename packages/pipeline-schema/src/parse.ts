import { parse as parseYaml } from 'yaml';
import { PipelineSchema } from './schema.js';
import type { Pipeline } from './schema.js';

/**
 * Parse and validate a pipeline.yaml string.
 *
 * Throws an Error whose message includes each failing field's path and reason,
 * so the dashboard / CLI can surface "this is what's wrong with your YAML".
 */
export function parsePipelineYaml(yaml: string): Pipeline {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`pipeline-schema: failed to parse YAML: ${reason}`);
  }

  if (raw === null || raw === undefined) {
    throw new Error('pipeline-schema: YAML document is empty');
  }

  const result = PipelineSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

  throw new Error(`pipeline-schema: validation failed: ${issues}`);
}
