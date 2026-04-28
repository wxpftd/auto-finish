<script lang="ts">
  import RequirementCard from '$lib/components/RequirementCard.svelte';
  import { api } from '$lib/api/client';
  import { mockPipeline } from '$lib/api/mock-data';
  import type { Requirement, RequirementStatus } from '$lib/api/types';

  const statusOptions: { value: RequirementStatus | 'all'; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'queued', label: '排队中' },
    { value: 'running', label: '执行中' },
    { value: 'awaiting_gate', label: '待审核' },
    { value: 'awaiting_changes', label: '请求修改' },
    { value: 'done', label: '已完成' },
    { value: 'failed', label: '已失败' },
  ];

  let filter = $state<RequirementStatus | 'all'>('all');
  let requirements = $state<Requirement[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    loading = true;
    error = null;
    const f = filter === 'all' ? undefined : { status: filter };
    api
      .listRequirements(f)
      .then((r) => (requirements = r))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (loading = false));
  });
</script>

<section class="space-y-6 fade-in">
  <header class="flex items-baseline justify-between">
    <div>
      <h1 class="text-xl font-semibold">需求</h1>
      <p class="mt-0.5 text-xs text-[var(--color-fg-2)]">
        实时面板，按状态筛选。
      </p>
    </div>
    <span class="text-xs text-[var(--color-fg-3)]">
      共 {requirements.length} 项
    </span>
  </header>

  <!-- 状态筛选条 -->
  <div class="flex flex-wrap items-center gap-1 border-b border-[var(--color-line)] pb-2">
    {#each statusOptions as opt (opt.value)}
      <button
        type="button"
        onclick={() => (filter = opt.value)}
        class={`tab ${filter === opt.value ? 'tab-active' : ''}`}
      >
        {opt.label}
      </button>
    {/each}
  </div>

  {#if loading}
    <p class="text-xs text-[var(--color-fg-3)]">加载中…</p>
  {:else if error}
    <div class="card border-[var(--color-danger)] px-4 py-3 text-sm text-[var(--color-danger)]">
      {error}
    </div>
  {:else if requirements.length === 0}
    <div class="card px-4 py-12 text-center text-sm text-[var(--color-fg-2)]">
      该筛选条件下没有需求。
    </div>
  {:else}
    <ul class="space-y-2">
      {#each requirements as requirement (requirement.id)}
        <li><RequirementCard {requirement} pipeline={mockPipeline} /></li>
      {/each}
    </ul>
  {/if}
</section>
