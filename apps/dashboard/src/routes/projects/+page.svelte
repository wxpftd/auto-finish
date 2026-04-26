<script lang="ts">
  import { api } from '$lib/api/client';
  import type { Project } from '$lib/api/types';

  let projects = $state<Project[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    api
      .listProjects()
      .then((p) => {
        projects = p;
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
      <h1 class="text-xl font-semibold text-slate-900">Projects</h1>
      <p class="mt-1 text-sm text-slate-600">
        Each project owns one or more git repos and a default pipeline.
      </p>
    </div>
  </header>

  {#if loading}
    <p class="text-sm text-slate-500">Loading…</p>
  {:else if error}
    <p class="text-sm text-rose-600">Error: {error}</p>
  {:else if projects.length === 0}
    <p class="text-sm text-slate-500">No projects yet.</p>
  {:else}
    <ul class="grid gap-4 md:grid-cols-2">
      {#each projects as project (project.id)}
        <li>
          <a
            href={`/projects/${project.id}`}
            class="block rounded-lg border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500 hover:shadow"
          >
            <h2 class="text-base font-semibold text-slate-900">{project.name}</h2>
            {#if project.description}
              <p class="mt-1 text-sm text-slate-600">{project.description}</p>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
