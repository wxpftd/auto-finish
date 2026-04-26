<script lang="ts">
  let {
    stageNames,
    currentIndex,
    status,
  }: {
    stageNames: string[];
    currentIndex: number;
    /** Free-form requirement status (we accept anything, only special-case
     * the few that affect rendering). */
    status?: string;
  } = $props();

  // Each segment is `done` (green) | `current` (brand color) | `pending` (slate).
  // If `status` is `done`, all segments are done.
  function segmentClass(i: number): string {
    if (status === 'done') return 'bg-emerald-500';
    if (status === 'failed' && i === currentIndex) return 'bg-rose-500';
    if (i < currentIndex) return 'bg-emerald-500';
    if (i === currentIndex) {
      if (status === 'awaiting_gate') return 'bg-amber-400';
      if (status === 'awaiting_changes') return 'bg-rose-400';
      return 'bg-brand-500';
    }
    return 'bg-slate-200';
  }
</script>

<div>
  <div class="flex gap-1">
    {#each stageNames as _, i (i)}
      <div class={`h-1.5 flex-1 rounded-full ${segmentClass(i)}`}></div>
    {/each}
  </div>
  <div class="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-slate-500">
    {#each stageNames as name, i (name)}
      <span class={i === currentIndex ? 'font-semibold text-slate-700' : ''}>{name}</span>
    {/each}
  </div>
</div>
