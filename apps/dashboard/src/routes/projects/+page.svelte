<script lang="ts">
  import { api } from '$lib/api/client';
  import type { Project } from '$lib/api/types';
  import { formatRelative, shortId } from '$lib/i18n';

  let projects = $state<Project[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    api
      .listProjects()
      .then((p) => (projects = p))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (loading = false));
  });
</script>

<section class="space-y-6 fade-in">
  <header class="flex items-baseline justify-between">
    <div>
      <h1 class="text-xl font-semibold">项目</h1>
      <p class="mt-0.5 text-xs text-[var(--color-fg-2)]">
        每个项目绑定一组 git 仓库与默认流水线。
      </p>
    </div>
    <span class="text-xs text-[var(--color-fg-3)]">{projects.length} 项</span>
  </header>

  {#if loading}
    <p class="text-xs text-[var(--color-fg-3)]">加载中…</p>
  {:else if error}
    <div class="card border-[var(--color-danger)] px-4 py-3 text-sm text-[var(--color-danger)]">
      {error}
    </div>
  {:else if projects.length === 0}
    <div class="card px-4 py-12 text-center text-sm text-[var(--color-fg-2)]">
      尚未配置任何项目。
    </div>
  {:else}
    <ul class="card divide-y divide-[var(--color-line)]">
      {#each projects as project (project.id)}
        <li>
          <a href={`/projects/${project.id}`} class="row row-hover">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-[var(--color-fg-0)]">
                  {project.name}
                </span>
                <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
                  {shortId(project.id)}
                </span>
              </div>
              {#if project.description}
                <p class="mt-0.5 truncate text-xs text-[var(--color-fg-2)]">
                  {project.description}
                </p>
              {/if}
            </div>
            <span class="tag tag-neutral">
              {project.sandbox_config_json.provider}
            </span>
            <span class="hidden text-xs text-[var(--color-fg-3)] md:inline">
              {formatRelative(project.updated_at)}
            </span>
            <span class="text-xs text-[var(--color-fg-3)]">→</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
