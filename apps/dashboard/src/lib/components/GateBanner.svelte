<script lang="ts">
  import { stageLabel } from '$lib/i18n';

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

  let visible = $derived(status === 'awaiting_gate' || status === 'awaiting_changes');
  let isAwaitingGate = $derived(status === 'awaiting_gate');

  let title = $derived(
    isAwaitingGate
      ? `等待人工评审${stageName ? ` · ${stageLabel(stageName)}` : ''}`
      : `已请求修改${stageName ? ` · ${stageLabel(stageName)}` : ''}`,
  );
</script>

{#if visible}
  <div
    class="flex items-center gap-3 rounded border px-4 py-3"
    style="
      background: {isAwaitingGate ? 'var(--color-warn-soft)' : 'var(--color-danger-soft)'};
      border-color: {isAwaitingGate ? 'var(--color-warn)' : 'var(--color-danger)'};
      border-left-width: 3px;
    "
  >
    <span
      class="dot pulse"
      style="background: {isAwaitingGate ? 'var(--color-warn)' : 'var(--color-danger)'}"
    ></span>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium text-[var(--color-fg-0)]">{title}</p>
      {#if feedback}
        <p class="mt-1 whitespace-pre-line text-xs text-[var(--color-fg-1)]">{feedback}</p>
      {:else}
        <p class="mt-0.5 text-xs text-[var(--color-fg-2)]">
          {isAwaitingGate
            ? '人工查阅最新产物后决定是否放行至下一阶段。'
            : '等待智能体根据反馈重新交付。'}
        </p>
      {/if}
    </div>
    {#if gateId}
      <a href={`/gates/${gateId}`} class="btn btn-secondary shrink-0">
        前往评审
      </a>
    {/if}
  </div>
{/if}
