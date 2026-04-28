<script lang="ts">
  import { api } from '$lib/api/client';
  import { mockPipeline } from '$lib/api/mock-data';
  import RequirementCard from '$lib/components/RequirementCard.svelte';
  import type { Project, Requirement, StageExecution } from '$lib/api/types';

  let requirements = $state<Requirement[]>([]);
  let gates = $state<StageExecution[]>([]);
  let projects = $state<Project[]>([]);
  let loading = $state(true);

  $effect(() => {
    Promise.all([api.listRequirements(), api.listGates(), api.listProjects()])
      .then(([r, g, p]) => {
        requirements = r;
        gates = g;
        projects = p;
      })
      .finally(() => (loading = false));
  });

  let stats = $derived({
    running: requirements.filter((r) => r.status === 'running').length,
    awaitingGate: requirements.filter((r) => r.status === 'awaiting_gate').length,
    awaitingChanges: requirements.filter((r) => r.status === 'awaiting_changes').length,
    done: requirements.filter((r) => r.status === 'done').length,
    total: requirements.length,
  });
</script>

<section class="space-y-6 fade-in">
  <header class="flex items-baseline justify-between">
    <h1 class="text-xl font-semibold">概览</h1>
    <a href="/requirements" class="text-xs text-[var(--color-fg-2)] hover:text-[var(--color-fg-0)]">
      查看全部需求 →
    </a>
  </header>

  <!-- 统计指标行 -->
  <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
    {#each [
      { label: '执行中', value: stats.running, color: 'var(--color-accent)' },
      { label: '待审核', value: stats.awaitingGate, color: 'var(--color-warn)' },
      { label: '请求修改', value: stats.awaitingChanges, color: 'var(--color-danger)' },
      { label: '已完成', value: stats.done, color: 'var(--color-success)' },
      { label: '需求总数', value: stats.total, color: 'var(--color-fg-2)' },
    ] as item (item.label)}
      <div class="card px-4 py-3">
        <p class="text-xs text-[var(--color-fg-2)]">{item.label}</p>
        <p class="mt-1 text-2xl font-semibold tabular-nums" style="color: {item.color}">
          {item.value}
        </p>
      </div>
    {/each}
  </div>

  <!-- 待审关卡 + 项目 二栏 -->
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
    <div class="lg:col-span-2">
      <div class="mb-2 flex items-baseline justify-between">
        <h2 class="caption">最近需求</h2>
        <span class="text-xs text-[var(--color-fg-3)]">{requirements.length} 项</span>
      </div>
      {#if loading}
        <p class="text-xs text-[var(--color-fg-3)]">加载中…</p>
      {:else if requirements.length === 0}
        <div class="card px-4 py-6 text-center text-xs text-[var(--color-fg-2)]">暂无需求</div>
      {:else}
        <ul class="space-y-2">
          {#each requirements.slice(0, 5) as r (r.id)}
            <li><RequirementCard requirement={r} pipeline={mockPipeline} /></li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="space-y-4">
      <div>
        <div class="mb-2 flex items-baseline justify-between">
          <h2 class="caption">待审关卡</h2>
          <span class="text-xs text-[var(--color-fg-3)]">{gates.length}</span>
        </div>
        {#if gates.length === 0}
          <div class="card px-4 py-3 text-xs text-[var(--color-fg-2)]">没有待审关卡</div>
        {:else}
          <ul class="card divide-y divide-[var(--color-line)]">
            {#each gates as g (g.id)}
              <li>
                <a href={`/gates/${g.id}`} class="row row-hover">
                  <span class="dot bg-[var(--color-warn)]"></span>
                  <span class="flex-1 truncate text-sm">{g.stage_name}</span>
                  <span class="text-xs text-[var(--color-fg-3)]">→</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div>
        <div class="mb-2 flex items-baseline justify-between">
          <h2 class="caption">项目</h2>
          <span class="text-xs text-[var(--color-fg-3)]">{projects.length}</span>
        </div>
        {#if projects.length === 0}
          <div class="card px-4 py-3 text-xs text-[var(--color-fg-2)]">暂无项目</div>
        {:else}
          <ul class="card divide-y divide-[var(--color-line)]">
            {#each projects as p (p.id)}
              <li>
                <a href={`/projects/${p.id}`} class="row row-hover">
                  <span class="flex-1 truncate text-sm">{p.name}</span>
                  <span class="text-xs text-[var(--color-fg-3)]">→</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
</section>
