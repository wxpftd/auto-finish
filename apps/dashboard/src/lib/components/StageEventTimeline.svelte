<script lang="ts">
  import type { StageEventRow } from '$lib/api/types';

  let { events, maxHeight = '24rem' }: { events: StageEventRow[]; maxHeight?: string } = $props();

  type ToolPair = {
    use: StageEventRow;
    result?: StageEventRow;
  };

  type Item =
    | { kind: 'session_init'; ev: StageEventRow }
    | { kind: 'assistant_text'; ev: StageEventRow }
    | { kind: 'tool'; pair: ToolPair }
    | { kind: 'parse_error'; ev: StageEventRow }
    | { kind: 'failed'; ev: StageEventRow }
    | { kind: 'rate_limited'; ev: StageEventRow }
    | { kind: 'finished'; ev: StageEventRow }
    | { kind: 'cold_restart'; ev: StageEventRow }
    | { kind: 'unknown'; ev: StageEventRow };

  let items = $derived(buildItems(events));

  function buildItems(evs: StageEventRow[]): Item[] {
    const pendingUses = new Map<string, ToolPair>();
    const out: Item[] = [];
    for (const ev of evs) {
      if (ev.type === 'tool_use') {
        const id = String(ev.id ?? '');
        const pair: ToolPair = { use: ev };
        pendingUses.set(id, pair);
        out.push({ kind: 'tool', pair });
        continue;
      }
      if (ev.type === 'tool_result') {
        const id = String(ev.tool_use_id ?? '');
        const pair = pendingUses.get(id);
        if (pair) {
          pair.result = ev;
          continue;
        }
        out.push({ kind: 'unknown', ev });
        continue;
      }
      switch (ev.type) {
        case 'session_init':
        case 'assistant_text':
        case 'parse_error':
        case 'failed':
        case 'rate_limited':
        case 'finished':
        case 'cold_restart':
          out.push({ kind: ev.type, ev });
          break;
        default:
          out.push({ kind: 'unknown', ev });
      }
    }
    return out;
  }

  function fmtTime(ts: unknown): string {
    if (typeof ts !== 'number') return '';
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function rawJson(v: unknown): string {
    try {
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function fmtJson(v: unknown, max = 600): string {
    const s = rawJson(v);
    return s.length > max ? s.slice(0, max) + '\n…(已截断 ' + (s.length - max) + ' 字符)' : s;
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 老浏览器/无 https：静默失败，不打扰用户 */
    }
  }

  function fmtCost(v: unknown): string {
    if (typeof v !== 'number') return '';
    return `$${v.toFixed(4)}`;
  }

  function fmtDuration(ms: unknown): string {
    if (typeof ms !== 'number' || ms < 0) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  }

  function asNumber(v: unknown): number | null {
    return typeof v === 'number' ? v : null;
  }

  function asString(v: unknown): string {
    return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  }

  let openInputs = $state<Record<number, boolean>>({});
  function toggleInput(idx: number): void {
    openInputs = { ...openInputs, [idx]: !openInputs[idx] };
  }
</script>

{#if events.length === 0}
  <div class="card px-3 py-6 text-center text-xs text-[var(--color-fg-3)]">
    该阶段尚未产生事件
  </div>
{:else}
  <ol
    class="space-y-1.5 overflow-y-auto pr-1"
    style="max-height: {maxHeight};"
  >
    {#each items as item, idx (idx)}
      {#if item.kind === 'session_init'}
        <li class="flex items-start gap-2 text-[11px]">
          <span class="mt-1 text-[var(--color-fg-3)]">{fmtTime(item.ev.ts)}</span>
          <span class="tag tag-accent">session</span>
          <span class="font-mono text-[var(--color-fg-2)]">
            {asString(item.ev.model)}
          </span>
          {#if Array.isArray(item.ev.tools)}
            <span class="text-[var(--color-fg-3)]">
              tools: {(item.ev.tools as unknown[]).length}
            </span>
          {/if}
        </li>
      {:else if item.kind === 'assistant_text'}
        <li class="flex items-start gap-2">
          <span class="mt-1 text-[11px] text-[var(--color-fg-3)]">{fmtTime(item.ev.ts)}</span>
          <div class="flex-1 rounded border-l-2 border-[var(--color-fg-3)] bg-[var(--color-bg-1)] px-3 py-1.5 text-xs leading-relaxed text-[var(--color-fg-1)]">
            {asString(item.ev.text)}
          </div>
        </li>
      {:else if item.kind === 'tool'}
        {@const tool = asString(item.pair.use.tool) || '?'}
        {@const isErr = !!item.pair.result && Boolean(item.pair.result.is_error)}
        <li class="flex items-start gap-2">
          <span class="mt-1 text-[11px] text-[var(--color-fg-3)]">{fmtTime(item.pair.use.ts)}</span>
          <div class="flex-1">
            <button
              type="button"
              onclick={() => toggleInput(idx)}
              class="flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-xs transition"
              style="border-color: {isErr ? 'var(--color-danger)' : 'var(--color-line-strong)'}; background: {isErr ? 'var(--color-danger-soft)' : 'var(--color-bg-2)'};"
            >
              <span class="font-mono font-medium" style="color: {isErr ? 'var(--color-danger)' : 'var(--color-accent)'};">
                {tool}
              </span>
              {#if !item.pair.result}
                <span class="tag tag-warn ml-auto">运行中</span>
              {:else if isErr}
                <span class="tag tag-danger ml-auto">错误</span>
              {:else}
                <span class="tag tag-success ml-auto">完成</span>
              {/if}
              <span class="text-[var(--color-fg-3)]">{openInputs[idx] ? '▾' : '▸'}</span>
            </button>
            {#if openInputs[idx]}
              <div class="mt-1 space-y-1.5">
                <div>
                  <div class="caption mb-0.5 flex items-center gap-2 text-[10px]">
                    <span>input</span>
                    <button
                      type="button"
                      class="ml-auto text-[var(--color-fg-3)] normal-case tracking-normal hover:text-[var(--color-fg-1)]"
                      onclick={() => copyText(rawJson(item.pair.use.input))}
                      aria-label="复制 input 原文"
                      title="复制原文（含被截断的部分）"
                    >复制</button>
                  </div>
                  <pre class="pre-soft rounded bg-[var(--color-bg-1)] px-2 py-1.5 font-mono text-[11px] leading-5 text-[var(--color-fg-1)]">{fmtJson(item.pair.use.input)}</pre>
                </div>
                {#if item.pair.result}
                  <div>
                    <div class="caption mb-0.5 flex items-center gap-2 text-[10px]">
                      <span>output{isErr ? '（错误）' : ''}</span>
                      <button
                        type="button"
                        class="ml-auto text-[var(--color-fg-3)] normal-case tracking-normal hover:text-[var(--color-fg-1)]"
                        onclick={() => copyText(asString(item.pair.result?.content))}
                        aria-label="复制 output 原文"
                        title="复制原文（含被截断的部分）"
                      >复制</button>
                    </div>
                    <pre class="pre-soft rounded bg-[var(--color-bg-1)] px-2 py-1.5 font-mono text-[11px] leading-5" style="color: {isErr ? 'var(--color-danger)' : 'var(--color-fg-1)'};">{fmtJson(asString(item.pair.result.content))}</pre>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </li>
      {:else if item.kind === 'parse_error' || item.kind === 'failed'}
        <li class="flex min-w-0 items-start gap-2">
          <span class="mt-1 shrink-0 text-[11px] text-[var(--color-fg-3)]">{fmtTime(item.ev.ts)}</span>
          <div class="min-w-0 flex-1 rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-xs">
            <div class="mb-1 flex flex-wrap items-start gap-x-2 gap-y-1">
              <span class="tag tag-danger shrink-0">{item.ev.type}</span>
              {#if item.ev.type === 'failed'}
                <span class="min-w-0 flex-1 font-mono text-[var(--color-danger)]" style="overflow-wrap: anywhere;">
                  {asString(item.ev.reason)}
                </span>
              {:else}
                <span class="min-w-0 flex-1 font-mono text-[var(--color-danger)]" style="overflow-wrap: anywhere;">
                  {asString(item.ev.error)}
                </span>
              {/if}
            </div>
            {#if item.ev.type === 'parse_error' && item.ev.raw !== undefined}
              <div class="caption mb-0.5 flex items-center gap-2 text-[10px]">
                <span>raw</span>
                <button
                  type="button"
                  class="ml-auto text-[var(--color-fg-3)] normal-case tracking-normal hover:text-[var(--color-fg-1)]"
                  onclick={() => copyText(rawJson(item.ev.raw))}
                  aria-label="复制 raw 原文"
                  title="复制原文（含被截断的部分）"
                >复制</button>
              </div>
              <pre class="pre-soft font-mono text-[11px] leading-5 text-[var(--color-fg-2)]">{fmtJson(item.ev.raw, 400)}</pre>
            {/if}
          </div>
        </li>
      {:else if item.kind === 'rate_limited'}
        <li class="flex items-start gap-2 text-[11px]">
          <span class="mt-1 text-[var(--color-fg-3)]">{fmtTime(item.ev.ts)}</span>
          <span class="tag tag-warn">rate limited</span>
          {#if item.ev.reset_at !== undefined}
            <span class="text-[var(--color-fg-2)]">
              重置于 {asString(item.ev.reset_at)}
            </span>
          {/if}
        </li>
      {:else if item.kind === 'finished'}
        {@const exit = asNumber(item.ev.exit_code) ?? 0}
        {@const turns = asNumber(item.ev.num_turns)}
        {@const duration = asNumber(item.ev.duration_ms)}
        {@const cost = asNumber(item.ev.total_cost_usd)}
        <li class="flex items-center gap-2 border-t border-[var(--color-line)] pt-2 text-[11px]">
          <span class="text-[var(--color-fg-3)]">{fmtTime(item.ev.ts)}</span>
          <span class={`tag ${exit === 0 ? 'tag-success' : 'tag-danger'}`}>
            exit {exit}
          </span>
          {#if turns !== null}
            <span class="text-[var(--color-fg-2)]">{turns} 轮</span>
          {/if}
          {#if duration !== null}
            <span class="text-[var(--color-fg-2)]">{fmtDuration(duration)}</span>
          {/if}
          {#if cost !== null}
            <span class="font-mono text-[var(--color-fg-2)]">{fmtCost(cost)}</span>
          {/if}
        </li>
      {:else if item.kind === 'cold_restart'}
        <li class="flex items-center gap-2 border-y-2 border-dashed border-[var(--color-warn)] py-2 text-[11px]">
          <span class="text-[var(--color-fg-3)]">{fmtTime(item.ev.ts)}</span>
          <span class="tag tag-warn">cold restart</span>
          <span class="text-[var(--color-fg-2)]">
            {asString(item.ev.reason)}
          </span>
        </li>
      {:else}
        <li class="flex items-start gap-2 text-[11px]">
          <span class="mt-1 text-[var(--color-fg-3)]">{fmtTime(item.ev.ts)}</span>
          <span class="tag tag-neutral">{item.ev.type}</span>
          <span class="font-mono text-[var(--color-fg-3)]">{fmtJson(item.ev, 200)}</span>
        </li>
      {/if}
    {/each}
  </ol>
{/if}
