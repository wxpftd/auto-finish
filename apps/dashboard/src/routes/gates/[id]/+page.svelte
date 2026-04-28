<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '$lib/api/client';
  import type { StageExecution } from '$lib/api/types';
  import { shortId, stageExecutionStatusLabels, stageLabel } from '$lib/i18n';

  let gate = $state<StageExecution | null>(null);
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
    api
      .getGate(id)
      .then((g) => (gate = g))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)))
      .finally(() => (loading = false));
  });

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
</script>

<section class="mx-auto max-w-2xl space-y-6 fade-in">
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
    <!-- 关卡信息 -->
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
        </div>
        <span class={`tag ${tagFor[gate.status] ?? 'tag-neutral'}`}>
          {stageExecutionStatusLabels[gate.status] ?? gate.status}
        </span>
      </div>
    </div>

    <!-- 决策 -->
    <div class="space-y-3">
      <div>
        <label for="feedback" class="caption mb-1.5 block">
          评审意见<span class="ml-1 text-[var(--color-fg-3)]">（可选）</span>
        </label>
        <textarea
          id="feedback"
          rows="4"
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
        <div class="flex items-center gap-2">
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
          <span class="ml-auto text-[11px] text-[var(--color-fg-3)]">
            决策不可撤销
          </span>
        </div>
      {:else}
        <p class="text-xs text-[var(--color-fg-2)]">
          决策已记录，无法再次操作。
        </p>
      {/if}
    </div>
  {/if}
</section>
