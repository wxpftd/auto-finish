/**
 * Default `makeSandboxProvider` factory — chooses a `SandboxProvider`
 * implementation based on the project-schema's `sandbox_config.provider`
 * field.
 *
 * Used as the production default for `RunnerDeps.makeSandboxProvider`. Tests
 * still inject their own factory (typically returning `InMemoryProvider`) so
 * unit-test paths don't touch real backends.
 *
 *   - `opensandbox` — production default; HTTP-backed provider speaking
 *                      the local sandbox-server `/v1` REST API.
 *   - `in_memory`   — test reference; useful for smoke / mocking flows.
 *
 * The factory deliberately stays config-driven and free of side effects —
 * one switch, no env reads beyond what each provider already does on its
 * own. Adding new providers only touches this file plus the schema enum.
 */

import type { SandboxConfig as ProjectSandboxConfig } from '@auto-finish/project-schema';
import type { SandboxProvider } from './interface.js';
import { InMemoryProvider } from './in-memory-provider.js';
import { OpenSandboxProvider } from './opensandbox-provider.js';

/**
 * Construct a `SandboxProvider` for the given project sandbox config.
 *
 * Throws on unknown providers — the schema's `SandboxProviderSchema` enum
 * gates this at parse time, so an unknown value here means a config bypassed
 * validation (programmer error).
 */
export function defaultMakeSandboxProvider(
  config: ProjectSandboxConfig,
): SandboxProvider {
  switch (config.provider) {
    case 'opensandbox':
      return new OpenSandboxProvider(
        config.endpoint !== undefined ? { endpoint: config.endpoint } : {},
      );
    case 'in_memory':
      return new InMemoryProvider();
    default: {
      const exhaustive: never = config.provider;
      throw new Error(`unknown sandbox provider: ${String(exhaustive)}`);
    }
  }
}
