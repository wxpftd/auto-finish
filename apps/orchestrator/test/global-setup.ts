/**
 * Vitest globalSetup for the orchestrator suite.
 *
 * Single responsibility: ensure `apps/dashboard/.svelte-kit/tsconfig.json`
 * exists before vite/esbuild start transforming files. The cross-cutting
 * `realtime-e2e.test.ts` imports dashboard sources via relative path; vite's
 * `loadTsconfigJsonForFile` walks up from a dashboard file, finds
 * `apps/dashboard/tsconfig.json`, and follows its
 *   "extends": "./.svelte-kit/tsconfig.json"
 * If `.svelte-kit/` doesn't exist (fresh checkout, before `svelte-kit sync`),
 * the discovery throws and the orchestrator suite fails at the transform
 * step — long before the test body runs.
 *
 * We materialize a *minimal* tsconfig stub at that path. The real svelte-kit
 * sync will overwrite it the first time the dashboard runs `dev`/`check`,
 * so this is a no-op when the dashboard's own tooling has already filled
 * the directory in. We intentionally don't run `svelte-kit sync` here:
 * that would couple orchestrator tests to svelte's CLI being installed in
 * orchestrator's node_modules, which it isn't.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STUB = {
  compilerOptions: {
    moduleResolution: 'bundler',
    module: 'esnext',
    target: 'esnext',
    lib: ['esnext', 'DOM', 'DOM.Iterable'],
    noEmit: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
    types: ['node'],
  },
  include: ['../src/**/*.ts'],
  exclude: ['../node_modules/**'],
};

export default function setup(): void {
  // __dirname here is apps/orchestrator/test → walk up to apps/dashboard.
  const target = resolve(
    __dirname,
    '../../dashboard/.svelte-kit/tsconfig.json',
  );
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(STUB, null, 2) + '\n', 'utf8');
}
