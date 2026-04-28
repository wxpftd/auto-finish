<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '$lib/api/client';
  import StageEventTimeline from '$lib/components/StageEventTimeline.svelte';
  import DiffViewer from '$lib/components/DiffViewer.svelte';
  import type { Artifact, StageExecution } from '$lib/api/types';
  import { shortId, stageExecutionStatusLabels, stageLabel } from '$lib/i18n';

  let gate = $state<StageExecution | null>(null);
  let artifacts = $state<Artifact[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let feedback = $state('');
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let submitted = $state<'approved' | 'rejected' | null>(null);

  $effect(() => {
    const id = page.params.id;
    if (!id) return;
    loading = true;
    artifacts = [];
    api
      .getGate(id)
      .then((g) => {
        gate = g;
        return api.listArtifactsForStage(g.id).catch(() => [] as Artifact[]);
      })
      .then((list) => {
        if (list) artifacts = list;
      })
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (loading = false));
  });

  let diffArtifacts = $derived(artifacts.filter((a) => a.type === 'diff'));

  async function decide(decision: 'approved' | 'rejected'): Promise<void> {
    if (!gate) return;
    submitting = true;
    submitError = null;
    try {
      const result = await api.decideGate(
        gate.id,
        decision,
        feedback.trim() ? feedback : undefined,
      );
      gate = result.stage;
      submitted = decision;
      setTimeout(() => void goto('/gates'), 700);
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  const tagFor: Record<string, string> = {
    awaiting_gate: 'tag-warn',
    gate_approved: 'tag-success',
    gate_rejected: 'tag-danger',
  };

  let events = $derived(gate?.events_json ?? []);
  let toolCount = $derived(events.filter((e) => e.type === 'tool_use').length);
  let errorCount = $derived(
    events.filter(
      (e) =>
        e.type === 'failed' ||
        e.type === 'parse_error' ||
        (e.type === 'tool_result' && Boolean((e as { is_error?: unknown }).is_error)),
    ).length,
  );
</script>

<section class="mx-auto max-w-6xl space-y-6 fade-in">
  <header>
    <a
      href="/gates"
      class="text-xs text-[var(--color-fg-2)] hover:text-[var(--color-fg-0)]"
    >
      ← 关卡
    </a>
    <h1 class="mt-2 text-xl font-semibold">关卡评审</h1>
  </header>

  {#if loading}
    <p class="text-xs text-[var(--color-fg-3)]">加载中…</p>
  {:else if error || !gate}
    <div class="card border-[var(--color-danger)] px-4 py-3 text-sm text-[var(--color-danger)]">
      {error ?? '未找到该关卡'}
    </div>
  {:else}
    <div class="card px-4 py-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-base font-semibold">{stageLabel(gate.stage_name)}</span>
            <span class="font-mono text-[11px] text-[var(--color-fg-3)]">
              {gate.stage_name}
            </span>
          </div>
          <p class="mt-1 font-mono text-[11px] text-[var(--color-fg-3)]">
            run · {shortId(gate.run_id, 12)} · gate · {shortId(gate.id, 12)}
          </p>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-fg-2)]">
            <span>{events.length} 个事件</span>
            <span>{toolCount} 次工具调用</span>
            {#if errorCount > 0}
              <span class="text-[var(--color-danger)]">{errorCount} 个错误</span>
            {/if}
          </div>
        </div>
        <span class={`tag ${tagFor[gate.status] ?? 'tag-neutral'}`}>
          {stageExecutionStatusLabels[gate.status] ?? gate.status}
        </span>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
      <div class="space-y-5">
        {#if diffArtifacts.length > 0}
          <div class="space-y-3">
            <h2 class="caption">代码改动 ({diffArtifacts.length})</h2>
            {#each diffArtifacts as a (a.id)}
              <div class="space-y-1.5">
                <div class="flex items-center gap-2 text-xs">
                  <span class="tag tag-neutral">diff</span>
                  <span class="font-mono text-[var(--color-fg-1)]">{a.path}</span>
                </div>
                {#if a.preview}
                  <DiffViewer patch={a.preview} />
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <div class="space-y-3">
          <h2 class="caption">本阶段事件流</h2>
          {#if events.length === 0}
            <div class="card px-4 py-6 text-center text-xs text-[var(--color-fg-3)]">
              该阶段尚未产生事件——可能尚未真正开始
            </div>
          {:else}
            <div class="card px-3 py-3">
              <StageEventTimeline {events} maxHeight="32rem" />
            </div>
          {/if}
        </div>
      </div>

      <div class="space-y-3">
        <h2 class="caption">决策</h2>
        <div class="space-y-3">
          <div>
            <label for="feedback" class="caption mb-1.5 block">
              评审意见<span class="ml-1 text-[var(--color-fg-3)]">（可选）</span>
            </label>
            <textarea
              id="feedback"
              rows="6"
              bind:value={feedback}
              placeholder="给智能体或下一位评审人留下笔记…"
              class="input"
              disabled={gate.status !== 'awaiting_gate' || submitting}
            ></textarea>
            <p class="mt-1 text-[11px] text-[var(--color-fg-3)]">
              驳回时建议填写具体修改方向；放行可留空。
            </p>
          </div>

          {#if submitError}
            <div class="card border-[var(--color-danger)] px-3 py-2 text-xs text-[var(--color-danger)]">
              {submitError}
            </div>
          {/if}

          {#if submitted}
            <div class="card border-[var(--color-success)] px-3 py-2 text-xs">
              决策已提交：
              <span style="color: {submitted === 'approved' ? 'var(--color-success)' : 'var(--color-danger)'}">
                {submitted === 'approved' ? '放行' : '驳回'}
              </span>
              ，正在返回列表…
            </div>
          {:else if gate.status === 'awaiting_gate'}
            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="btn btn-success"
                onclick={() => decide('approved')}
                disabled={submitting}
              >
                放行至下一阶段
              </button>
              <button
                type="button"
                class="btn btn-danger"
                onclick={() => decide('rejected')}
                disabled={submitting}
              >
                驳回 · 请求修改
              </button>
              <span class="w-full text-[11px] text-[var(--color-fg-3)]">
                决策不可撤销
              </span>
            </div>
          {:else}
            <p class="text-xs text-[var(--color-fg-2)]">
              决策已记录，无法再次操作。
            </p>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</section>
