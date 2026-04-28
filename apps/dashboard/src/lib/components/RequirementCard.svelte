<script lang="ts">
  import type { Pipeline, Requirement } from '$lib/api/types';
  import PipelineProgress from './PipelineProgress.svelte';
  import { formatRelative, requirementStatusLabels, shortId } from '$lib/i18n';

  let {
    requirement,
    pipeline,
  }: {
    requirement: Requirement;
    pipeline: Pipeline;
  } = $props();

  const tagClassFor: Record<string, string> = {
    queued: 'tag-neutral',
    running: 'tag-accent',
    awaiting_gate: 'tag-warn',
    awaiting_changes: 'tag-danger',
    done: 'tag-success',
    failed: 'tag-danger',
  };

  function tagFor(status: string): string {
    return `tag ${tagClassFor[status] ?? 'tag-neutral'}`;
  }

  function labelFor(status: string): string {
    return requirementStatusLabels[status] ?? status;
  }

  let stageNames = $derived(pipeline.stages.map((s) => s.name));
  let currentIndex = $derived(
    requirement.current_stage_id
      ? stageNames.indexOf(requirement.current_stage_id)
      : -1,
  );
</script>

<a
  href={`/requirements/${requirement.id}`}
  class="card card-hover block px-4 py-3"
>
  <div class="flex items-center gap-3">
    <!-- 主要信息：标题 + 描述 -->
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class={tagFor(requirement.status)}>
          {labelFor(requirement.status)}
        </span>
        <h3 class="truncate text-sm font-medium text-[var(--color-fg-0)]">
          {requirement.title}
        </h3>
      </div>
      <p class="mt-1 truncate text-xs text-[var(--color-fg-2)]">
        {requirement.description}
      </p>
    </div>

    <!-- 元信息列：来源 / 时间 / ID -->
    <div class="hidden shrink-0 flex-col items-end gap-1 text-xs text-[var(--color-fg-2)] md:flex">
      <span>{requirement.source}{requirement.source_ref ? ` · ${requirement.source_ref}` : ''}</span>
      <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
        {shortId(requirement.id)} · {formatRelative(requirement.updated_at)}
      </span>
    </div>
  </div>

  <!-- 流水线进度（细条 + 阶段名） -->
  <div class="mt-3">
    <PipelineProgress {stageNames} {currentIndex} status={requirement.status} />
  </div>
</a>
