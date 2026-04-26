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
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Locally mutable state — seeded from `data` inside an effect so navigations
  // back to a different requirement re-seed correctly.
  let stages = $state<StageExecution[]>([]);
  let liveStatus = $state<RequirementStatus | string>('queued');
  let currentStage = $state<string | null>(null);

  let log = $state<LogEntry[]>([]);
  let liveConnected = $state(false);
  let liveError = $state<string | null>(null);

  // Seed local state from `data` whenever the requirement id changes.
  $effect(() => {
    const reqId = data.requirement.id;
    void reqId; // tracked dependency
    stages = data.run?.stage_executions ? [...data.run.stage_executions] : [];
    liveStatus = data.requirement.status;
    currentStage = data.requirement.current_stage_id;
    log = [];
  });

  let stageNames = $derived(data.pipeline.stages.map((s) => s.name));
  let currentIndex = $derived(
    currentStage !== null ? stageNames.indexOf(currentStage) : -1,
  );

  const prStatusColor: Record<string, string> = {
    open: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    merged: 'bg-purple-100 text-purple-800 ring-purple-200',
    closed: 'bg-slate-100 text-slate-700 ring-slate-200',
    changes_requested: 'bg-rose-100 text-rose-800 ring-rose-200',
  };

  const seStatusColor: Record<string, string> = {
    pending: 'text-slate-400',
    running: 'text-blue-700',
    awaiting_gate: 'text-amber-700',
    gate_approved: 'text-emerald-700',
    gate_rejected: 'text-rose-700',
    succeeded: 'text-emerald-700',
    failed: 'text-rose-700',
    skipped: 'text-slate-400',
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
          if (code !== 1000) {
            liveError = `closed (${code})`;
          }
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
    return () => {
      handle?.close();
    };
  });
</script>

<section class="space-y-8">
  <header>
    <a href="/requirements" class="text-xs text-slate-500 hover:text-slate-700">
      &larr; All requirements
    </a>
    <div class="mt-2 flex items-center gap-3">
      <h1 class="text-xl font-semibold text-slate-900">{data.requirement.title}</h1>
      <span
        class={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${
          liveConnected
            ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
            : liveError
              ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
              : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
        }`}
        title={liveError ?? (liveConnected ? 'Live updates connected' : 'Connecting…')}
      >
        <span
          class={`h-1.5 w-1.5 rounded-full ${
            liveConnected ? 'bg-emerald-500' : liveError ? 'bg-rose-500' : 'bg-slate-400'
          }`}
        ></span>
        {liveConnected ? 'live' : liveError ? 'offline' : 'connecting'}
      </span>
    </div>
    <p class="mt-1 text-sm text-slate-600">{data.requirement.description}</p>
    <p class="mt-2 text-xs text-slate-500">
      Project: <a class="underline hover:text-slate-700" href={`/projects/${data.project.id}`}>{data.project.name}</a>
      · Source: {data.requirement.source}
      {#if data.requirement.source_ref}
        · {data.requirement.source_ref}
      {/if}
    </p>
  </header>

  <GateBanner
    status={liveStatus as RequirementStatus}
    stageName={currentStage}
  />

  <div>
    <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">
      Pipeline
    </h2>
    <div class="mt-3 rounded-md border border-slate-200 bg-white p-4">
      <PipelineProgress {stageNames} {currentIndex} status={liveStatus as RequirementStatus} />
    </div>
    {#if stages.length > 0}
      <ul class="mt-4 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white text-sm">
        {#each stages as se (se.id)}
          <li class="flex items-center justify-between px-4 py-2.5">
            <span class="font-medium text-slate-800">{se.stage_name}</span>
            <span class={`text-xs uppercase tracking-wide ${seStatusColor[se.status] ?? 'text-slate-500'}`}>
              {se.status}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if log.length > 0}
    <div>
      <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Live event log
      </h2>
      <ol class="mt-3 max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700">
        {#each log as entry, i (i)}
          <li>
            <span class="text-slate-400">{new Date(entry.at).toLocaleTimeString()}</span>
            {' '}{entry.line}
          </li>
        {/each}
      </ol>
    </div>
  {/if}

  {#if data.artifacts.length > 0}
    <div>
      <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Artifacts
      </h2>
      <ul class="mt-3 space-y-3">
        {#each data.artifacts as artifact (artifact.id)}
          <li class="rounded-md border border-slate-200 bg-white">
            <div class="flex items-center justify-between border-b border-slate-200 px-4 py-2">
              <span class="font-mono text-xs text-slate-700">{artifact.path}</span>
              <span class="text-xs uppercase tracking-wide text-slate-500">{artifact.type}</span>
            </div>
            {#if artifact.preview}
              <pre class="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed text-slate-700">{artifact.preview}</pre>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if data.pull_requests.length > 0}
    <div>
      <h2 class="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Pull requests
      </h2>
      <ul class="mt-3 space-y-2">
        {#each data.pull_requests as pr (pr.id)}
          <li class="flex items-center justify-between rounded-md border border-slate-200 bg-white px-4 py-3">
            <a href={pr.pr_url} target="_blank" rel="noreferrer" class="text-sm text-brand-700 hover:underline">
              #{pr.pr_number} ({pr.repo_id})
            </a>
            <span class={`pill ring-1 ring-inset ${prStatusColor[pr.status] ?? 'bg-slate-100 text-slate-700 ring-slate-200'}`}>
              {pr.status}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>
