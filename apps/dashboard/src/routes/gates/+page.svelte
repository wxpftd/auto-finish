<script lang="ts">
  import { api } from '$lib/api/client';
  import type { StageExecution } from '$lib/api/types';

  let gates = $state<StageExecution[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    api
      .listGates()
      .then((g) => {
        gates = g;
      })
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        loading = false;
      });
  });

  function statusStyle(status: string): string {
    if (status === 'awaiting_gate') return 'bg-amber-100 text-amber-800 ring-amber-200';
    if (status === 'gate_approved' || status === 'succeeded') {
      return 'bg-emerald-100 text-emerald-800 ring-emerald-200';
    }
    if (status === 'gate_rejected' || status === 'failed') {
      return 'bg-rose-100 text-rose-800 ring-rose-200';
    }
    return 'bg-slate-100 text-slate-700 ring-slate-200';
  }
</script>

<section class="space-y-6">
  <header>
    <h1 class="text-xl font-semibold text-slate-900">Gates</h1>
    <p class="mt-1 text-sm text-slate-600">
      Stage executions awaiting human review.
    </p>
  </header>

  {#if loading}
    <p class="text-sm text-slate-500">Loading…</p>
  {:else if error}
    <p class="text-sm text-rose-600">Error: {error}</p>
  {:else if gates.length === 0}
    <p class="text-sm text-slate-500">No gates pending.</p>
  {:else}
    <ul class="space-y-3">
      {#each gates as gate (gate.id)}
        <li>
          <a
            href={`/gates/${gate.id}`}
            class="block rounded-md border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-500 hover:shadow"
          >
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-slate-900">
                  Stage: <span class="font-mono text-xs">{gate.stage_name}</span>
                </p>
                <p class="mt-1 text-xs text-slate-500">
                  Run <span class="font-mono">{gate.run_id}</span>
                </p>
              </div>
              <span class={`pill ring-1 ring-inset ${statusStyle(gate.status)}`}>
                {gate.status.replaceAll('_', ' ')}
              </span>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
