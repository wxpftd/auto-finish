<script lang="ts">
  import RequirementCard from '$lib/components/RequirementCard.svelte';
  // FIXME: 待 orchestrator 暴露按 project 查询 pipeline 的接口后切换到真实 pipeline。
  import { mockPipeline } from '$lib/api/mock-data';
  import { shortId } from '$lib/i18n';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<section class="space-y-6 fade-in">
  <header>
    <a
      href="/projects"
      class="text-xs text-[var(--color-fg-2)] hover:text-[var(--color-fg-0)]"
    >
      ← 项目
    </a>
    <div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="text-xl font-semibold">{data.project.name}</h1>
      <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
        {shortId(data.project.id, 12)}
      </span>
    </div>
    {#if data.project.description}
      <p class="mt-1 max-w-2xl text-xs text-[var(--color-fg-2)]">
        {data.project.description}
      </p>
    {/if}
  </header>

  <!-- 仓库 -->
  <div>
    <div class="mb-2 flex items-baseline justify-between">
      <h2 class="caption">仓库</h2>
      <span class="text-xs text-[var(--color-fg-3)]">{data.repos.length} 个</span>
    </div>
    <ul class="card divide-y divide-[var(--color-line)]">
      {#each data.repos as repo (repo.id)}
        <li class="row">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium">{repo.name}</span>
              <span class="tag tag-neutral">{repo.default_branch}</span>
            </div>
            <p class="mt-0.5 truncate font-mono text-[11px] text-[var(--color-fg-3)]">
              {repo.git_url}
            </p>
          </div>
          <div class="hidden flex-col items-end text-xs md:flex">
            <span class="font-mono text-[11px] text-[var(--color-fg-2)]">{repo.working_dir}</span>
            {#if repo.test_command}
              <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
                测试 · {repo.test_command}
              </span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </div>

  <!-- 需求 -->
  <div>
    <div class="mb-2 flex items-baseline justify-between">
      <h2 class="caption">需求</h2>
      <span class="text-xs text-[var(--color-fg-3)]">{data.requirements.length} 项</span>
    </div>
    {#if data.requirements.length === 0}
      <div class="card px-4 py-8 text-center text-sm text-[var(--color-fg-2)]">
        该项目下暂无需求。
      </div>
    {:else}
      <ul class="space-y-2">
        {#each data.requirements as requirement (requirement.id)}
          <li><RequirementCard {requirement} pipeline={mockPipeline} /></li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
