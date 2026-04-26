<script lang="ts">
  import RequirementCard from '$lib/components/RequirementCard.svelte';
  // FIXME: when the orchestrator exposes per-project pipeline lookup, fetch
  // the active pipeline here. For now the dashboard renders requirement cards
  // against a default 4-stage skeleton (mockPipeline is shape-compatible).
  import { mockPipeline } from '$lib/api/mock-data';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<section class="space-y-8">
  <header>
    <a href="/projects" class="text-xs text-slate-500 hover:text-slate-700">
      &larr; All projects
    </a>
    <h1 class="mt-2 text-xl font-semibold text-slate-900">{data.project.name}</h1>
    {#if data.project.description}
      <p class="mt-1 text-sm text-slate-600">{data.project.description}</p>
    {/if}
  </header>

  <div>
    <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">Repos</h2>
    <ul class="mt-3 grid gap-3 md:grid-cols-2">
      {#each data.repos as repo (repo.id)}
        <li class="rounded-md border border-slate-200 bg-white p-4">
          <div class="flex items-center justify-between">
            <span class="font-medium text-slate-900">{repo.name}</span>
            <span class="text-xs text-slate-500">{repo.default_branch}</span>
          </div>
          <p class="mt-1 break-all text-xs text-slate-500">{repo.git_url}</p>
          <p class="mt-1 text-xs text-slate-500">{repo.working_dir}</p>
          {#if repo.test_command}
            <p class="mt-1 text-xs text-slate-500">test: <code>{repo.test_command}</code></p>
          {/if}
        </li>
      {/each}
    </ul>
  </div>

  <div>
    <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">
      Requirements ({data.requirements.length})
    </h2>
    <ul class="mt-3 space-y-3">
      {#each data.requirements as requirement (requirement.id)}
        <li>
          <RequirementCard {requirement} pipeline={mockPipeline} />
        </li>
      {/each}
    </ul>
  </div>
</section>
