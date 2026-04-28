<script lang="ts">
  import GateBanner from '$lib/components/GateBanner.svelte';
  import PipelineProgress from '$lib/components/PipelineProgress.svelte';
  import { api } from '$lib/api/client';
  import { connectWs, type WsClientHandle } from '$lib/api/ws';
  import type {
    PipelineEvent,
    RequirementStatus,
    StageExecution,
  } from '$lib/api/types';
  import { reduceEvent, type LogEntry } from '$lib/api/event-reducer';
  import {
    prStatusLabels,
    requirementStatusLabels,
    shortId,
    stageExecutionStatusLabels,
    stageLabel,
  } from '$lib/i18n';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let stages = $state<StageExecution[]>([]);
  let liveStatus = $state<RequirementStatus | string>('queued');
  let currentStage = $state<string | null>(null);
  let log = $state<LogEntry[]>([]);
  let liveConnected = $state(false);
  let liveError = $state<string | null>(null);

  $effect(() => {
    const reqId = data.requirement.id;
    void reqId;
    stages = data.run?.stage_executions ? [...data.run.stage_executions] : [];
    liveStatus = data.requirement.status;
    currentStage = data.requirement.current_stage_id;
    log = [];
  });

  let stageNames = $derived(data.pipeline.stages.map((s) => s.name));
  let currentIndex = $derived(
    currentStage !== null ? stageNames.indexOf(currentStage) : -1,
  );

  const reqTag: Record<string, string> = {
    queued: 'tag-neutral',
    running: 'tag-accent',
    awaiting_gate: 'tag-warn',
    awaiting_changes: 'tag-danger',
    done: 'tag-success',
    failed: 'tag-danger',
  };

  // 阶段执行状态对应的颜色（仅前景）
  const seColor: Record<string, string> = {
    pending: 'var(--color-fg-3)',
    running: 'var(--color-accent)',
    awaiting_gate: 'var(--color-warn)',
    gate_approved: 'var(--color-success)',
    gate_rejected: 'var(--color-danger)',
    succeeded: 'var(--color-success)',
    failed: 'var(--color-danger)',
    skipped: 'var(--color-fg-3)',
  };

  const prTag: Record<string, string> = {
    open: 'tag-success',
    merged: 'tag-accent',
    closed: 'tag-neutral',
    changes_requested: 'tag-danger',
  };

  function applyEvent(ev: PipelineEvent): void {
    const next = reduceEvent({ log, liveStatus, currentStage, stages }, ev);
    log = next.log;
    liveStatus = next.liveStatus;
    currentStage = next.currentStage;
    stages = next.stages;
  }

  $effect(() => {
    const runId = data.run?.id;
    if (!runId) return;
    let handle: WsClientHandle | null = null;
    try {
      handle = connectWs({
        filter: `run:${runId}`,
        onEvent: (ev) => applyEvent(ev),
        onClose: (code) => {
          liveConnected = false;
          if (code !== 1000) liveError = `已断开 (${code})`;
        },
      });
      handle.ready
        .then(() => {
          liveConnected = true;
          liveError = null;
        })
        .catch((err: unknown) => {
          liveError = err instanceof Error ? err.message : String(err);
        });
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
    return () => handle?.close();
  });

  function fmtClock(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
</script>

<section class="space-y-6 fade-in">
  <header>
    <a
      href="/requirements"
      class="text-xs text-[var(--color-fg-2)] hover:text-[var(--color-fg-0)]"
    >
      ← 需求
    </a>

    <div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 class="text-xl font-semibold">{data.requirement.title}</h1>
      <span class={`tag ${reqTag[liveStatus] ?? 'tag-neutral'}`}>
        {requirementStatusLabels[liveStatus] ?? liveStatus}
      </span>
      <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
        {shortId(data.requirement.id, 12)}
      </span>
      <!-- live 连接状态 -->
      <span class="ml-auto flex items-center gap-1.5 text-xs text-[var(--color-fg-2)]">
        <span
          class={`dot ${liveConnected ? 'pulse bg-[var(--color-success)]' : liveError ? 'bg-[var(--color-danger)]' : 'pulse bg-[var(--color-fg-3)]'}`}
        ></span>
        {liveConnected ? '实时' : liveError ? '离线' : '连接中'}
      </span>
    </div>

    <p class="mt-2 max-w-3xl text-xs text-[var(--color-fg-1)]">
      {data.requirement.description}
    </p>

    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-fg-2)]">
      <span>
        项目 ·
        <a class="text-[var(--color-fg-1)] hover:text-[var(--color-fg-0)]" href={`/projects/${data.project.id}`}>
          {data.project.name}
        </a>
      </span>
      <span>来源 · {data.requirement.source}</span>
      {#if data.requirement.source_ref}
        <span class="font-mono text-[var(--color-fg-3)]">{data.requirement.source_ref}</span>
      {/if}
    </div>
  </header>

  <GateBanner
    status={liveStatus as RequirementStatus}
    stageName={currentStage}
  />

  <!-- 流水线 -->
  <div>
    <h2 class="caption mb-2">流水线</h2>
    <div class="card px-4 py-4">
      <PipelineProgress
        {stageNames}
        {currentIndex}
        status={liveStatus as RequirementStatus}
      />
    </div>

    {#if stages.length > 0}
      <ul class="card mt-2 divide-y divide-[var(--color-line)]">
        {#each stages as se (se.id)}
          <li class="row">
            <span class="dot" style="background: {seColor[se.status] ?? 'var(--color-fg-3)'}"></span>
            <span class="flex-1 text-sm text-[var(--color-fg-0)]">
              {stageLabel(se.stage_name)}
            </span>
            <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
              {se.stage_name}
            </span>
            <span class="text-xs" style="color: {seColor[se.status] ?? 'var(--color-fg-3)'}">
              {stageExecutionStatusLabels[se.status] ?? se.status}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- 实时事件流 -->
  {#if log.length > 0}
    <div>
      <h2 class="caption mb-2">实时事件</h2>
      <ol class="card max-h-64 overflow-y-auto bg-[var(--color-bg-1)] px-3 py-2 font-mono text-[11px] leading-6">
        {#each log as entry, i (i)}
          <li class="flex gap-2">
            <span class="text-[var(--color-fg-3)]">{fmtClock(entry.at)}</span>
            <span class="text-[var(--color-fg-1)]">{entry.line}</span>
          </li>
        {/each}
      </ol>
    </div>
  {/if}

  <!-- 产物 -->
  {#if data.artifacts.length > 0}
    <div>
      <h2 class="caption mb-2">产物</h2>
      <ul class="space-y-2">
        {#each data.artifacts as artifact (artifact.id)}
          <li class="card overflow-hidden">
            <div class="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2">
              <span class="font-mono text-[11px] text-[var(--color-fg-1)]">{artifact.path}</span>
              <span class="tag tag-neutral">{artifact.type}</span>
            </div>
            {#if artifact.preview}
              <pre class="overflow-x-auto bg-[var(--color-bg-1)] px-4 py-3 font-mono text-[11px] leading-6 text-[var(--color-fg-1)]">{artifact.preview}</pre>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Pull Requests -->
  {#if data.pull_requests.length > 0}
    <div>
      <h2 class="caption mb-2">Pull Requests</h2>
      <ul class="card divide-y divide-[var(--color-line)]">
        {#each data.pull_requests as pr (pr.id)}
          <li class="row">
            <a
              href={pr.pr_url}
              target="_blank"
              rel="noreferrer"
              class="flex flex-1 items-center gap-2 hover:text-[var(--color-fg-0)]"
            >
              <span class="font-mono text-sm text-[var(--color-accent)]">#{pr.pr_number}</span>
              <span class="text-sm">{pr.repo_id}</span>
              <span class="text-xs text-[var(--color-fg-3)]">↗</span>
            </a>
            <span class={`tag ${prTag[pr.status] ?? 'tag-neutral'}`}>
              {prStatusLabels[pr.status] ?? pr.status}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>
