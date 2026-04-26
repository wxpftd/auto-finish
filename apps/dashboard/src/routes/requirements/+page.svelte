<script lang="ts">
  import RequirementCard from '$lib/components/RequirementCard.svelte';
  import { api } from '$lib/api/client';
  import { mockPipeline } from '$lib/api/mock-data';
  import type { Requirement, RequirementStatus } from '$lib/api/types';

  const statusOptions: { value: RequirementStatus | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'queued', label: 'Queued' },
    { value: 'running', label: 'Running' },
    { value: 'awaiting_gate', label: 'Awaiting gate' },
    { value: 'awaiting_changes', label: 'Changes requested' },
    { value: 'done', label: 'Done' },
    { value: 'failed', label: 'Failed' },
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
      .then((r) => {
        requirements = r;
      })
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        loading = false;
      });
  });
</script>

<section class="space-y-6">
  <header class="flex items-end justify-between">
    <div>
      <h1 class="text-xl font-semibold text-slate-900">Requirements</h1>
      <p class="mt-1 text-sm text-slate-600">
        Live board. Filter by status to focus on what needs attention.
      </p>
    </div>
    <select
      bind:value={filter}
      class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
    >
      {#each statusOptions as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </header>

  {#if loading}
    <p class="text-sm text-slate-500">Loading…</p>
  {:else if error}
    <p class="text-sm text-rose-600">Error: {error}</p>
  {:else if requirements.length === 0}
    <p class="text-sm text-slate-500">No requirements match this filter.</p>
  {:else}
    <ul class="space-y-3">
      {#each requirements as requirement (requirement.id)}
        <li>
          <RequirementCard {requirement} pipeline={mockPipeline} />
        </li>
      {/each}
    </ul>
  {/if}
</section>
