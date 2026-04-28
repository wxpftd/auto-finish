<script lang="ts">
  import StageEventTimeline from './StageEventTimeline.svelte';
  import DiffViewer from './DiffViewer.svelte';
  import type { Artifact, StageExecution, StageEventRow } from '$lib/api/types';
  import { shortId, stageExecutionStatusLabels, stageLabel } from '$lib/i18n';

  let {
    stage,
    artifacts = [],
    onClose,
  }: {
    stage: StageExecution | null;
    artifacts?: Artifact[];
    onClose: () => void;
  } = $props();

  type Tab = 'overview' | 'events' | 'tools' | 'artifacts' | 'errors';
  let active = $state<Tab>('overview');
  let expanded = $state(false);

  $effect(() => {
    void stage?.id;
    active = 'overview';
  });

  const tagFor: Record<string, string> = {
    pending: 'tag-neutral',
    running: 'tag-accent',
    awaiting_gate: 'tag-warn',
    gate_approved: 'tag-success',
    gate_rejected: 'tag-danger',
    succeeded: 'tag-success',
    completed: 'tag-success',
    failed: 'tag-danger',
    skipped: 'tag-neutral',
  };

  let events = $derived(stage?.events_json ?? []);
  let toolPairs = $derived(extractToolPairs(events));
  let errorEvents = $derived(events.filter((e) => e.type === 'failed' || e.type === 'parse_error' || (e.type === 'tool_result' && Boolean(e.is_error))));
  let finishedEv = $derived(events.findLast((e) => e.type === 'finished'));

  function asNumber(v: unknown): number | null {
    return typeof v === 'number' ? v : null;
  }

  function extractToolPairs(evs: StageEventRow[]): { use: StageEventRow; result?: StageEventRow }[] {
    const byId = new Map<string, { use: StageEventRow; result?: StageEventRow }>();
    const order: string[] = [];
    for (const ev of evs) {
      if (ev.type === 'tool_use') {
        const id = String(ev.id ?? '');
        byId.set(id, { use: ev });
        order.push(id);
      } else if (ev.type === 'tool_result') {
        const id = String(ev.tool_use_id ?? '');
        const pair = byId.get(id);
        if (pair) pair.result = ev;
      }
    }
    return order.map((id) => byId.get(id)).filter((x): x is { use: StageEventRow; result?: StageEventRow } => Boolean(x));
  }

  function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  }

  function fmtTime(ts: number | null): string {
    if (ts === null) return '—';
    return new Date(ts).toLocaleString();
  }

  function fmtSize(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }

  function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if stage}
  <div
    class="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
    onclick={onClose}
    role="presentation"
    aria-hidden="true"
  ></div>

  <aside
    class={`fixed inset-y-0 right-0 z-50 flex w-full ${expanded ? 'max-w-6xl' : 'max-w-3xl'} flex-col border-l border-[var(--color-line-strong)] bg-[var(--color-bg-1)] shadow-xl transition-[max-width] duration-200 fade-in`}
    aria-label="阶段详情"
  >
    <header class="flex items-center gap-3 border-b border-[var(--color-line)] px-5 py-3">
      <h2 class="text-base font-semibold">
        {stageLabel(stage.stage_name)}
      </h2>
      <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
        {stage.stage_name}
      </span>
      <span class={`tag ${tagFor[stage.status] ?? 'tag-neutral'}`}>
        {stageExecutionStatusLabels[stage.status] ?? stage.status}
      </span>
      <button
        type="button"
        onclick={() => (expanded = !expanded)}
        class="ml-auto rounded p-1 text-[var(--color-fg-3)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-0)]"
        aria-label={expanded ? '收起宽度' : '展开宽度'}
        title={expanded ? '收起宽度' : '展开宽度'}
      >
        {expanded ? '⇥' : '⇤'}
      </button>
      <button
        type="button"
        onclick={onClose}
        class="rounded p-1 text-[var(--color-fg-3)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-0)]"
        aria-label="关闭"
      >
        ✕
      </button>
    </header>

    <nav class="flex items-center gap-1 border-b border-[var(--color-line)] px-3 py-1.5">
      {#each [
        ['overview', '概览'],
        ['events', `事件 (${events.length})`],
        ['tools', `工具 (${toolPairs.length})`],
        ['artifacts', `产物 (${artifacts.length})`],
        ['errors', `错误 (${errorEvents.length})`],
      ] as [key, label] (key)}
        <button
          type="button"
          class={`tab ${active === key ? 'tab-active' : ''}`}
          onclick={() => (active = key as Tab)}
        >
          {label}
        </button>
      {/each}
    </nav>

    <div class="flex-1 overflow-y-auto px-5 py-4">
      {#if active === 'overview'}
        <dl class="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-xs">
          <dt class="kv-key">stage_execution_id</dt>
          <dd class="kv-val font-mono">{shortId(stage.id, 16)}</dd>

          <dt class="kv-key">run_id</dt>
          <dd class="kv-val font-mono">{shortId(stage.run_id, 16)}</dd>

          <dt class="kv-key">状态</dt>
          <dd class="kv-val">{stageExecutionStatusLabels[stage.status] ?? stage.status}</dd>

          <dt class="kv-key">开始</dt>
          <dd class="kv-val">{fmtTime(stage.started_at)}</dd>

          <dt class="kv-key">结束</dt>
          <dd class="kv-val">{fmtTime(stage.finished_at)}</dd>

          {#if stage.finished_at !== null}
            <dt class="kv-key">耗时</dt>
            <dd class="kv-val">{fmtDuration(stage.finished_at - stage.started_at)}</dd>
          {/if}

          {#if stage.claude_session_id}
            <dt class="kv-key">claude session</dt>
            <dd class="kv-val font-mono">{stage.claude_session_id}</dd>
          {/if}

          {#if stage.claude_subprocess_pid !== null}
            <dt class="kv-key">pid</dt>
            <dd class="kv-val font-mono">{stage.claude_subprocess_pid}</dd>
          {/if}
        </dl>

        {#if finishedEv}
          {@const exit = asNumber(finishedEv.exit_code) ?? 0}
          {@const turns = asNumber(finishedEv.num_turns)}
          {@const duration = asNumber(finishedEv.duration_ms)}
          {@const cost = asNumber(finishedEv.total_cost_usd)}
          <div class="caption mt-5 mb-2">本次运行小结</div>
          <div class="card flex flex-wrap gap-x-5 gap-y-1.5 px-4 py-3 text-xs">
            <span>
              <span class="kv-key">退出码 </span>
              <span class="kv-val font-mono">{exit}</span>
            </span>
            {#if turns !== null}
              <span>
                <span class="kv-key">轮数 </span>
                <span class="kv-val font-mono">{turns}</span>
              </span>
            {/if}
            {#if duration !== null}
              <span>
                <span class="kv-key">CLI 耗时 </span>
                <span class="kv-val font-mono">{fmtDuration(duration)}</span>
              </span>
            {/if}
            {#if cost !== null}
              <span>
                <span class="kv-key">花费 </span>
                <span class="kv-val font-mono">${cost.toFixed(4)}</span>
              </span>
            {/if}
          </div>
        {/if}
      {:else if active === 'events'}
        <StageEventTimeline {events} maxHeight="100%" />
      {:else if active === 'tools'}
        {#if toolPairs.length === 0}
          <p class="text-xs text-[var(--color-fg-3)]">该阶段没有工具调用</p>
        {:else}
          {@const counts = toolPairs.reduce<Record<string, { total: number; err: number }>>((acc, p) => {
            const t = String(p.use.tool ?? '?');
            const isErr = !!p.result && Boolean(p.result.is_error);
            acc[t] = acc[t] ?? { total: 0, err: 0 };
            acc[t].total += 1;
            if (isErr) acc[t].err += 1;
            return acc;
          }, {})}
          <div class="caption mb-2">调用统计</div>
          <ul class="card divide-y divide-[var(--color-line)]">
            {#each Object.entries(counts).sort((a, b) => b[1].total - a[1].total) as [tool, c] (tool)}
              <li class="row text-xs">
                <span class="font-mono text-[var(--color-accent)]">{tool}</span>
                <span class="ml-auto text-[var(--color-fg-2)]">
                  {c.total} 次
                </span>
                {#if c.err > 0}
                  <span class="tag tag-danger">
                    {c.err} 错
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
          <div class="caption mt-5 mb-2">调用时序</div>
          <StageEventTimeline {events} maxHeight="100%" />
        {/if}
      {:else if active === 'artifacts'}
        {#if artifacts.length === 0}
          <p class="text-xs text-[var(--color-fg-3)]">该阶段尚未产生产物</p>
        {:else}
          <ul class="space-y-3">
            {#each artifacts as a (a.id)}
              <li class="space-y-1.5">
                <div class="flex items-center gap-2 text-xs">
                  <span class="tag tag-neutral">{a.type}</span>
                  <span class="font-mono text-[var(--color-fg-1)]">{a.path}</span>
                  <span class="ml-auto text-[var(--color-fg-3)]">{fmtSize(a.size)}</span>
                </div>
                {#if a.type === 'diff' && a.preview}
                  <DiffViewer patch={a.preview} />
                {:else if a.preview}
                  <pre class="card max-h-48 overflow-auto bg-[var(--color-bg-1)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--color-fg-1)]">{a.preview}</pre>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {:else if active === 'errors'}
        {#if errorEvents.length === 0}
          <p class="text-xs text-[var(--color-fg-3)]">该阶段没有错误事件</p>
        {:else}
          <StageEventTimeline events={errorEvents} maxHeight="100%" />
        {/if}
      {/if}
    </div>
  </aside>
{/if}
