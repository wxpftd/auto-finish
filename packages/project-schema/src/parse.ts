import { parse as parseYaml } from 'yaml';
import { ProjectConfigSchema } from './schema.js';
import type { ProjectConfig } from './schema.js';

/**
 * Parse and validate a project.yaml string.
 *
 * Throws an Error whose message includes each failing field's path and reason,
 * so the dashboard / CLI can surface "this is what's wrong with your YAML".
 */
export function parseProjectYaml(yaml: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`project-schema: failed to parse YAML: ${reason}`);
  }

  if (raw === null || raw === undefined) {
    throw new Error('project-schema: YAML document is empty');
  }

  const result = ProjectConfigSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');

  throw new Error(`project-schema: validation failed: ${issues}`);
}
