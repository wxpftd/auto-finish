import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config for the orchestrator.
 *
 * Two tweaks support the cross-cutting `src/wire/realtime-e2e.test.ts`,
 * which imports dashboard sources (`event-reducer.ts`, `ws.ts`) by relative
 * path so the test exercises the actual dashboard code rather than a copy:
 *
 *   1. `resolve.alias` for `$env/dynamic/public` mirrors the dashboard's
 *      vitest config — `ws.ts` reads SvelteKit's virtual env module; under
 *      plain vitest we redirect to a tiny stub the dashboard already ships.
 *
 *   2. `globalSetup` materializes a stub `apps/dashboard/.svelte-kit/
 *      tsconfig.json` if it's missing. Vite's tsconfig discovery walks up
 *      from each transformed file; for a dashboard file that lands at
 *      `apps/dashboard/tsconfig.json`, which `extends` the svelte-kit
 *      generated tsconfig that only exists after `svelte-kit sync`. The
 *      stub satisfies the discovery without coupling the orchestrator
 *      suite to svelte's CLI; the real svelte-kit sync will overwrite it
 *      the next time the dashboard's tooling runs.
 *
 * The alias only fires for the `$env/...` specifier; the global setup is a
 * no-op once the dashboard has been synced. Existing orchestrator tests are
 * unaffected by either tweak.
 */
export default defineConfig({
  resolve: {
    alias: {
      '$env/dynamic/public': resolve(
        __dirname,
        '../dashboard/src/lib/test/env-stub.ts',
      ),
      '$env/static/public': resolve(
        __dirname,
        '../dashboard/src/lib/test/env-stub.ts',
      ),
    },
  },
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
    },
  },
});
