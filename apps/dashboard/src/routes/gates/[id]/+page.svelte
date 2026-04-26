<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api } from '$lib/api/client';
  import type { StageExecution } from '$lib/api/types';

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
      .then((g) => {
        gate = g;
      })
      .catch((e: unknown) => {
        error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        loading = false;
      });
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
      // Briefly show success then redirect to the gates list.
      setTimeout(() => {
        void goto('/gates');
      }, 700);
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function pillClass(status: string | undefined): string {
    if (status === 'awaiting_gate') return 'bg-amber-100 text-amber-800 ring-amber-200';
    if (status === 'gate_approved') return 'bg-emerald-100 text-emerald-800 ring-emerald-200';
    if (status === 'gate_rejected') return 'bg-rose-100 text-rose-800 ring-rose-200';
    return 'bg-slate-100 text-slate-700 ring-slate-200';
  }
</script>

<section class="space-y-6">
  <header>
    <a href="/gates" class="text-xs text-slate-500 hover:text-slate-700">
      &larr; All gates
    </a>
    <h1 class="mt-2 text-xl font-semibold text-slate-900">Gate review</h1>
  </header>

  {#if loading}
    <p class="text-sm text-slate-500">Loading…</p>
  {:else if error || !gate}
    <p class="text-sm text-rose-600">Error: {error ?? 'gate not found'}</p>
  {:else}
    <div class="rounded-md border border-slate-200 bg-white p-5">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium text-slate-900">
            Stage <span class="font-mono">{gate.stage_name}</span>
          </p>
          <p class="mt-1 text-xs text-slate-500">
            Run <span class="font-mono">{gate.run_id}</span>
          </p>
        </div>
        <span class={`pill ring-1 ring-inset ${pillClass(gate.status)}`}>
          {gate.status.replaceAll('_', ' ')}
        </span>
      </div>

      <div class="mt-5">
        <label for="feedback" class="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Feedback
        </label>
        <textarea
          id="feedback"
          rows="4"
          bind:value={feedback}
          placeholder="Optional notes for the agent or reviewer…"
          class="mt-2 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          disabled={gate.status !== 'awaiting_gate' || submitting}
        ></textarea>
      </div>

      {#if submitError}
        <p class="mt-3 text-sm text-rose-600">Error: {submitError}</p>
      {/if}

      {#if submitted}
        <p class="mt-5 text-sm text-emerald-700">
          Decision submitted ({submitted}). Redirecting…
        </p>
      {:else if gate.status === 'awaiting_gate'}
        <div class="mt-5 flex items-center gap-2">
          <button
            type="button"
            class="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60"
            onclick={() => decide('approved')}
            disabled={submitting}
          >
            Approve
          </button>
          <button
            type="button"
            class="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:opacity-60"
            onclick={() => decide('rejected')}
            disabled={submitting}
          >
            Reject
          </button>
        </div>
      {:else}
        <p class="mt-5 text-xs text-slate-500">
          Decision already recorded.
        </p>
      {/if}
    </div>
  {/if}
</section>
