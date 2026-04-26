import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config for the dashboard's unit tests.
 *
 * `$env/dynamic/public` is a SvelteKit-only virtual module. Vitest doesn't run
 * the SvelteKit plugin, so we alias it to a tiny stub that exports `env: {}`.
 * Modules that read `publicEnv?.PUBLIC_API_BASE_URL` will then see `undefined`
 * and fall back to their hard-coded defaults — exactly the path tests want to
 * exercise.
 */
export default defineConfig({
  resolve: {
    alias: {
      '$env/dynamic/public': resolve(__dirname, 'src/lib/test/env-stub.ts'),
      '$env/static/public': resolve(__dirname, 'src/lib/test/env-stub.ts'),
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    environment: 'node',
  },
});
