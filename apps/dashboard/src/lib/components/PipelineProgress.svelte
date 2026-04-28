<script lang="ts">
  import { stageLabel } from '$lib/i18n';

  let {
    stageNames,
    currentIndex,
    status,
  }: {
    stageNames: string[];
    currentIndex: number;
    status?: string;
  } = $props();

  /** 段位颜色：done/current/pending/fail —— 用 1 行细条而不是发光方格 */
  function segmentColor(i: number): string {
    if (status === 'done') return 'var(--color-success)';
    if (status === 'failed' && i === currentIndex) return 'var(--color-danger)';
    if (i < currentIndex) return 'var(--color-success)';
    if (i === currentIndex) {
      if (status === 'awaiting_gate' || status === 'awaiting_changes') {
        return 'var(--color-warn)';
      }
      return 'var(--color-accent)';
    }
    return 'var(--color-bg-4)';
  }
</script>

<div>
  <!-- 一根细条，按段着色（无发光、无圆角） -->
  <div class="flex h-1 gap-px overflow-hidden rounded-sm">
    {#each stageNames as _, i (i)}
      <div class="flex-1" style="background: {segmentColor(i)}"></div>
    {/each}
  </div>

  <!-- 阶段名行（中文 + 编号） -->
  <div class="mt-2 flex justify-between gap-2 text-xs">
    {#each stageNames as name, i (name)}
      {@const active = i === currentIndex}
      <span
        class={active ? 'font-medium text-[var(--color-fg-0)]' : 'text-[var(--color-fg-2)]'}
      >
        {stageLabel(name)}
      </span>
    {/each}
  </div>
</div>
