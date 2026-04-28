<script lang="ts">
  import { api } from '$lib/api/client';
  import type { StageExecution } from '$lib/api/types';
  import { shortId, stageExecutionStatusLabels, stageLabel } from '$lib/i18n';

  let gates = $state<StageExecution[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    api
      .listGates()
      .then((g) => (gates = g))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (loading = false));
  });

  const tagFor: Record<string, string> = {
    awaiting_gate: 'tag-warn',
    gate_approved: 'tag-success',
    succeeded: 'tag-success',
    gate_rejected: 'tag-danger',
    failed: 'tag-danger',
  };
</script>

<section class="space-y-6 fade-in">
  <header class="flex items-baseline justify-between">
    <div>
      <h1 class="text-xl font-semibold">关卡评审</h1>
      <p class="mt-0.5 text-xs text-[var(--color-fg-2)]">
        等待人工放行或驳回的阶段执行。
      </p>
    </div>
    <span class="text-xs text-[var(--color-fg-3)]">{gates.length} 项</span>
  </header>

  {#if loading}
    <p class="text-xs text-[var(--color-fg-3)]">加载中…</p>
  {:else if error}
    <div class="card border-[var(--color-danger)] px-4 py-3 text-sm text-[var(--color-danger)]">
      {error}
    </div>
  {:else if gates.length === 0}
    <div class="card px-4 py-12 text-center text-sm text-[var(--color-fg-2)]">
      没有待评审的关卡。
    </div>
  {:else}
    <ul class="card divide-y divide-[var(--color-line)]">
      {#each gates as gate (gate.id)}
        <li>
          <a href={`/gates/${gate.id}`} class="row row-hover">
            <span class="dot pulse bg-[var(--color-warn)]"></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">{stageLabel(gate.stage_name)}</span>
                <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
                  {gate.stage_name}
                </span>
              </div>
              <p class="mt-0.5 font-mono text-[11px] text-[var(--color-fg-3)]">
                run · {shortId(gate.run_id)} · gate · {shortId(gate.id)}
              </p>
            </div>
            <span class={`tag ${tagFor[gate.status] ?? 'tag-neutral'}`}>
              {stageExecutionStatusLabels[gate.status] ?? gate.status}
            </span>
            <span class="text-xs text-[var(--color-fg-3)]">→</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
