# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`auto-finish` is an orchestrator that drives a Claude Code subprocess through a multi-stage pipeline (需求分析 → 方案设计 → 实施 → 验证) inside a sandbox, across one or more git repos, and opens cross-linked PRs at the end. Human approval gates pause runs mid-pipeline.

It is a pnpm workspace monorepo:
- `apps/orchestrator` — Hono HTTP + WebSocket server, SQLite (drizzle), pipeline runner, sandbox abstraction.
- `apps/dashboard` — SvelteKit + Tailwind UI, consumes orchestrator REST + WS.
- `packages/project-schema`, `packages/pipeline-schema` — Zod + YAML schemas, published as workspace deps.

## Commands

All commands run from the repo root unless noted.

```bash
pnpm install                # bootstrap workspace
pnpm -r build               # MUST run before typecheck on a fresh checkout (see below)
pnpm -r typecheck           # tsc --noEmit across every workspace package
pnpm -r test                # vitest run in every package; OpenSandbox integration suite is gated off
pnpm smoke:all              # heavyweight smoke harness — see Smoke testing
```

Per-package:
```bash
pnpm --filter @auto-finish/orchestrator test                              # one package
pnpm --filter @auto-finish/orchestrator test -- src/runner/runner.test.ts # one file
pnpm --filter @auto-finish/orchestrator test:watch                        # watch mode
pnpm --filter @auto-finish/dashboard dev                                  # vite dev server
pnpm --filter @auto-finish/dashboard check                                # svelte-check
```

OpenSandbox integration tests (real `sandbox-server` HTTP traffic) are gated on `OPENSANDBOX_INTEGRATION=1`; default `pnpm -r test` skips them via `describe.skipIf(...)`. To exercise them:
```bash
OPENSANDBOX_INTEGRATION=1 pnpm --filter @auto-finish/orchestrator test src/sandbox/opensandbox-provider.integration.test.ts
```

Local infra (Postgres, Redis, Langfuse v3 stack, OpenSandbox server):
```bash
bash scripts/dev-up.sh      # docker compose up + healthcheck wait
bash scripts/seed-langfuse.sh   # provisions Langfuse project + writes keys to .env
bash scripts/dev-down.sh
```

Drizzle migrations live at `apps/orchestrator/src/db/migrations/` and are auto-applied by `runMigrations()` at server startup. Use `drizzle-kit` against `apps/orchestrator/drizzle.config.ts` to author new ones.

## Build-before-typecheck

`pnpm -r typecheck` will fail with `TS2307` on a clean checkout if you haven't run `pnpm -r build` first. The workspace packages' `package.json` `main`/`types` point at `./dist/*.{js,d.ts}`; until those exist, the orchestrator can't resolve `@auto-finish/pipeline-schema` / `@auto-finish/project-schema`. CI deliberately runs build first for the same reason — see `.github/workflows/ci.yml` and the `DEVIATION FROM SPEC` comment there.

## Architecture overview

**One process, two entry points.** The orchestrator is a single Node process serving Hono REST under `/api/*` and a WebSocket on `/ws` from the same `http.Server`. Wiring lives in `apps/orchestrator/src/wire/server.ts` (`startServer()`); `src/server.ts` is just the CLI shim. WebSocket auth rejection uses custom close code **4401** so dashboard clients can distinguish auth failure from generic abnormal close (1006).

**EventBus is in-process and synchronous.** `src/eventbus/bus.ts` wraps `mitt` with a topic-filter syntax (comma-separated, `*` wildcard). Subscribers run synchronously on `publish`. The runner publishes `PipelineEvent`s on the bus; the WS bridge in `wire/server.ts` fans them out to subscribed dashboard clients. Gate routes also publish `gate_decided` so a runner waiting at a gate resumes within ~50 ms instead of waiting on a DB poll.

**Runner pipeline.** `src/runner/runner.ts` drives one Requirement end-to-end: bootstrap sandbox → inject Claude credentials → clone every repo → for each Stage build claude argv (`src/claude/argv.ts`) → spawn (`src/claude/spawn.ts`) → stream stage events → persist → block at gate if configured → after all stages, detect diffs and open PRs. Almost every external interaction (`bootstrapEnv`, `injectCredentials`, `runClaude`, `detectChanges`, `openPrs`, `makeSandboxProvider`) is a pluggable `RunnerDeps` field with a real-implementation default — tests inject stubs.

**Gated-stage event ordering** (Fix #13 / Option A). For a stage with a gate, the runner emits `gate_required` BEFORE `stage_completed`, then:
- approved → `gate_decided(approved)` → `stage_completed` (stage truly done).
- rejected → `gate_decided(rejected)` → run transitions to `awaiting_changes` and `stage_completed` is **not** emitted (the operator wants rework).

`reduceRunStatus` in the dashboard is order-tolerant by design.

**Sandbox abstraction.** `src/sandbox/interface.ts` defines `SandboxProvider` / `SandboxSession` (run/startStream/readFile/writeFile/uploadFile/destroy). `src/sandbox/factory.ts` switches on `project.sandbox_config.provider`:
- `opensandbox` — production default. `OpenSandboxProvider` wraps the `@alibaba-group/opensandbox` TS SDK (Lifecycle API on port 8080 + per-sandbox `execd` API on 44772).
- `in_memory` — `InMemoryProvider`, the byte-faithful test reference.

Provider differences are documented inline in `opensandbox-provider.ts` (e.g. trailing-newline loss on stdout). `volumes[]` (with `backend: host | pvc | ossfs`) is consumed only by `OpenSandboxProvider`; in-memory ignores it.

**Warm-workspace strategy.** `project.sandbox_config.warm_strategy` ∈ `{ baked_image, shared_volume, cold_only }`. `cold_only` is the safe default. `baked_image` (recommended in production) requires `warm_image` + `base_image`; a Tier-2 cold-restart fallback in `src/runner/warm-fallback.ts` handles dep-install failures inside the warm image by snapshotting artifacts, restarting from `base_image`, and restoring them. `shared_volume` mounts a deps cache via `warm_volume_claim` + `warm_mount_path`.

**Multi-repo `git diff` convention.** `src/multi-repo/diff.ts` deliberately uses `git diff <base>` (no triple-dot), NOT `git diff <base>...<branch>`. The runner's stages edit the working tree via Claude's Edit/Write tools without committing; commit-range diffs would return empty and the runner would skip every PR. Caveat: brand-new untracked files are not detected by `git diff`; stages that create wholly new files must `git add -A` first. **Do not "fix" this to use `...` form.**

**DB schema invariants** (`src/db/schema.ts`).
- All IDs are string PKs auto-filled with `crypto.randomUUID()`.
- Timestamps are unix-ms `integer`, not drizzle `timestamp_ms` mode (we want plain JSON).
- JSON columns use `text({ mode: 'json' }).$type<…>()`; `$type` is type-only — runtime validation belongs in the repository layer.
- FK cascade policy is documented in the schema docstring; PRs preserve audit trail (`ON DELETE RESTRICT`), runs/stages cascade.

**Schema → DB → runner pipeline.** YAML config (`examples/default-project.yaml`) → `parseProjectYaml` (zod) → DB row in `projects.sandbox_config_json` (typed as `ProjectSandboxConfig`) → `defaultMakeSandboxProvider` reads `provider` and `endpoint`. Schema defaults (`provider: opensandbox`, `warm_strategy: cold_only`) are applied at parse time, so DB consumers can assume both fields are populated.

**Dashboard.** SvelteKit, Tailwind v4 via `@tailwindcss/vite`. Talks to the orchestrator over REST (`src/lib/api/client.ts`) and WS (`src/lib/api/ws.ts`). `event-reducer.ts` consumes the bus stream and is the single source of truth for run status — keep it order-tolerant; events can arrive in any order.

## TypeScript settings worth knowing

`tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, and `verbatimModuleSyntax`. Two consequences:
- Always import types with `import type { Foo } from '…'` — `verbatimModuleSyntax` will not auto-elide value-imports of types.
- Indexed access returns `T | undefined`; narrow before use.

Module system is **NodeNext + ESM**. Workspace package outputs are ESM (`.js` with `import` extension required at runtime).

## Smoke testing

`pnpm smoke:all` (in `apps/orchestrator/scripts/smoke-all.ts`) runs four scripts sequentially with fail-fast: `smoke-runner`, `smoke-gate`, `smoke-multistage`, `smoke-github`. Each guards on credentials (`claude` CLI, `gh` auth, SSH access) and prints `SKIPPED: <reason>` to exit 0 cleanly when prereqs are absent. Logs land under `.smoke-logs/<ISO-timestamp>/`. CI runs this only on `workflow_dispatch`.

`scripts/local-provider.ts` in the same directory is a library, not a runnable; do not add it to the SCRIPTS array.

## Claude CLI invocation

The orchestrator spawns `claude --print` as a subprocess in each stage. Default `max_turns` is **25** (overrideable per stage; the upstream CLI default of 50 was too generous in smoke testing). Credentials default to `host_mount` from `~/.claude/.credentials.json` — see `src/claude/credentials.ts`. When `ANTHROPIC_BASE_URL` is set, traffic is proxied through Langfuse for capture.

Subscription-mode credentials are preferred over API keys for any new design that involves Claude model calls — design new code paths around the `claude` CLI rather than a raw SDK + API key.

## Directory map

```
apps/
  orchestrator/
    src/
      api/          # Hono routes (projects, pipelines, requirements, runs, gates) + buildApp
      claude/       # argv builder, subprocess spawn, stream-json parser, credentials, stage events
      db/           # drizzle schema, repositories/, migrations/, client wiring
      eventbus/     # in-process EventBus, WS server (legacy, prefer wire/server.ts)
      multi-repo/   # clone, manifest, diff (note: git diff <base>, no ...)
      observability/
      pipeline/     # stage plan, gate logic, run-status reducer, PipelineEvent types
      pr/           # commit+push, gh PR creation, cross-link
      runner/       # runner.ts (the pipeline driver), warm-fallback.ts, types
      sandbox/      # interface, factory, OpenSandboxProvider, InMemoryProvider, contract tests
      wire/         # single-port HTTP+WS bootstrap (the production entry)
      server.ts     # CLI shim (env + signal handling)
    scripts/        # smoke-* harnesses
    test/global-setup.ts
  dashboard/
    src/
      lib/api/      # REST client, WS client, event reducer (order-tolerant)
      lib/components/  # GateBanner, PipelineProgress, RequirementCard
      routes/       # +page / +layout per top-level section
packages/
  project-schema/   # ProjectConfig, SandboxConfig, ClaudeConfig (zod) + YAML parser
  pipeline-schema/  # Pipeline, Stage, Gate (zod) + YAML parser
examples/           # default-project.yaml, default-pipeline.yaml, two-repo-demo, warm-image.Dockerfile
compose/opensandbox/  # config.toml for the dockerized sandbox-server
scripts/            # dev-up.sh, dev-down.sh, seed-langfuse.sh
```

## Environment

`.env.example` documents every variable. Defaults are safe for solo local laptop dev (SQLite mode, host-mounted Claude creds, in-process bus). Anything marked `CHANGEME` must be rotated before shared/remote use. `MAX_CONCURRENT_REQUIREMENTS` defaults to 5 because every sandbox shares the same Claude Code subscription credentials.
