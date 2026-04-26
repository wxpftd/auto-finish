import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Vitest config for the orchestrator.
 *
 * The `$env/dynamic/public` alias mirrors the dashboard's vitest config so
 * cross-cutting tests in `src/wire/` can import the dashboard's
 * `lib/api/ws.ts` (which depends on the SvelteKit virtual module) without
 * pulling in the SvelteKit Vite plugin. The alias only fires when something
 * imports that exact specifier — existing orchestrator tests are unaffected.
 *
 * `esbuild.tsconfigRaw` short-circuits esbuild's tsconfig discovery when it
 * transforms files that live under `apps/dashboard/`. Without this, esbuild
 * walks up from a dashboard file, finds `apps/dashboard/tsconfig.json`,
 * and tries to follow its `extends: "./.svelte-kit/tsconfig.json"` —
 * which only exists after `svelte-kit sync` has been run. Inlining a
 * minimal tsconfig means dashboard imports work even on a clean checkout.
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
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: 'es2022',
        useDefineForClassFields: true,
        verbatimModuleSyntax: true,
      },
    },
  },
  test: {
    globals: false,
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
    },
  },
});
