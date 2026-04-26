<script lang="ts">
  import type { Pipeline, Requirement, RequirementStatus } from '$lib/api/types';
  import PipelineProgress from './PipelineProgress.svelte';

  let {
    requirement,
    pipeline,
  }: {
    requirement: Requirement;
    pipeline: Pipeline;
  } = $props();

  const statusStyles: Record<string, string> = {
    queued: 'bg-slate-100 text-slate-700 ring-slate-200',
    running: 'bg-blue-100 text-blue-800 ring-blue-200',
    awaiting_gate: 'bg-amber-100 text-amber-800 ring-amber-200',
    awaiting_changes: 'bg-rose-100 text-rose-800 ring-rose-200',
    done: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    failed: 'bg-rose-200 text-rose-900 ring-rose-300',
  };

  const statusLabel: Record<string, string> = {
    queued: 'queued',
    running: 'running',
    awaiting_gate: 'awaiting gate',
    awaiting_changes: 'changes requested',
    done: 'done',
    failed: 'failed',
  };

  function styleFor(status: string): string {
    return statusStyles[status] ?? 'bg-slate-100 text-slate-700 ring-slate-200';
  }
  function labelFor(status: string): string {
    return statusLabel[status] ?? status;
  }

  let pillClass = $derived(
    `pill ring-1 ring-inset ${styleFor(requirement.status)}`,
  );
  let stageNames = $derived(pipeline.stages.map((s) => s.name));
  let currentIndex = $derived(
    requirement.current_stage_id
      ? stageNames.indexOf(requirement.current_stage_id)
      : -1,
  );
  let updatedRel = $derived(formatRelative(requirement.updated_at));
</script>

<a
  href={`/requirements/${requirement.id}`}
  class="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-500 hover:shadow"
>
  <div class="flex items-start justify-between gap-4">
    <div>
      <h3 class="text-base font-semibold text-slate-900">{requirement.title}</h3>
      <p class="mt-1 line-clamp-2 text-sm text-slate-600">{requirement.description}</p>
    </div>
    <span class={pillClass}>{labelFor(requirement.status)}</span>
  </div>

  <div class="mt-4">
    <PipelineProgress {stageNames} {currentIndex} status={requirement.status} />
  </div>

  <div class="mt-3 flex items-center justify-between text-xs text-slate-500">
    <span>{requirement.source}{requirement.source_ref ? ` · ${requirement.source_ref}` : ''}</span>
    <span>updated {updatedRel}</span>
  </div>
</a>

<script lang="ts" module>
  function formatRelative(ts: number): string {
    const diff = Date.now() - ts;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return 'just now';
    if (diff < hour) return `${Math.round(diff / minute)}m ago`;
    if (diff < day) return `${Math.round(diff / hour)}h ago`;
    return `${Math.round(diff / day)}d ago`;
  }
</script>
