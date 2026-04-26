<script lang="ts">
  let {
    status,
    stageName,
    gateId,
    feedback = null,
  }: {
    status: string;
    stageName: string | null;
    gateId?: string;
    feedback?: string | null;
  } = $props();

  // Only show for the two states that need attention.
  let visible = $derived(status === 'awaiting_gate' || status === 'awaiting_changes');

  let title = $derived(
    status === 'awaiting_gate'
      ? `Awaiting gate review${stageName ? ` · ${stageName}` : ''}`
      : `Changes requested${stageName ? ` · ${stageName}` : ''}`,
  );

  let bannerClass = $derived(
    status === 'awaiting_gate'
      ? 'border-amber-300 bg-amber-50 text-amber-900'
      : 'border-rose-300 bg-rose-50 text-rose-900',
  );
</script>

{#if visible}
  <div class={`flex items-start justify-between gap-4 rounded-md border p-4 ${bannerClass}`}>
    <div>
      <p class="text-sm font-semibold">{title}</p>
      {#if feedback}
        <p class="mt-1 whitespace-pre-line text-sm opacity-90">{feedback}</p>
      {:else}
        <p class="mt-1 text-sm opacity-80">
          A human reviewer needs to inspect the latest artifacts before this requirement can advance.
        </p>
      {/if}
    </div>
    {#if gateId}
      <a
        href={`/gates/${gateId}`}
        class="shrink-0 rounded bg-white px-3 py-1.5 text-sm font-medium shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
      >
        Review
      </a>
    {/if}
  </div>
{/if}
