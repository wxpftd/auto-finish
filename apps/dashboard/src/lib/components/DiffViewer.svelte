<script lang="ts">
  import { Diff2HtmlUI } from 'diff2html/lib/ui/js/diff2html-ui-base.js';
  import diff2htmlCssUrl from 'diff2html/bundles/css/diff2html.min.css?url';

  let { patch, outputFormat = 'line-by-line' }: { patch: string; outputFormat?: 'line-by-line' | 'side-by-side' } = $props();

  let host: HTMLDivElement;

  $effect(() => {
    if (!host) return;
    host.replaceChildren();
    if (!patch || patch.trim().length === 0) {
      return;
    }
    const ui = new Diff2HtmlUI(host, patch, {
      drawFileList: false,
      matching: 'lines',
      outputFormat,
      diffStyle: 'word',
      // Disable highlight.js — base class would throw without an hljs
      // instance, and we already style additions/deletions via our own CSS.
      highlight: false,
      synchronisedScroll: false,
      fileListToggle: false,
      fileContentToggle: false,
      stickyFileHeaders: false,
      smartSelection: false,
    });
    ui.draw();
  });
</script>

<svelte:head>
  <link rel="stylesheet" href={diff2htmlCssUrl} />
</svelte:head>

<div class="diff-viewer-host" bind:this={host}></div>

<style>
  .diff-viewer-host :global(.d2h-wrapper) {
    border: 1px solid var(--color-line-strong);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-bg-2);
  }
  .diff-viewer-host :global(.d2h-file-header),
  .diff-viewer-host :global(.d2h-file-name-wrapper) {
    background: var(--color-bg-3);
    color: var(--color-fg-1);
    border-bottom: 1px solid var(--color-line-strong);
  }
  .diff-viewer-host :global(.d2h-file-name) {
    color: var(--color-fg-0);
  }
  .diff-viewer-host :global(.d2h-code-line),
  .diff-viewer-host :global(.d2h-code-side-line) {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .diff-viewer-host :global(.d2h-code-linenumber),
  .diff-viewer-host :global(.d2h-code-side-linenumber) {
    color: var(--color-fg-3);
    background: var(--color-bg-2);
    border-color: var(--color-line);
  }
  .diff-viewer-host :global(.d2h-ins) {
    background: rgba(74, 222, 128, 0.08);
    color: var(--color-success);
  }
  .diff-viewer-host :global(.d2h-del) {
    background: rgba(239, 90, 90, 0.08);
    color: var(--color-danger);
  }
  .diff-viewer-host :global(.d2h-info) {
    color: var(--color-fg-2);
    background: var(--color-bg-1);
  }
  .diff-viewer-host :global(.d2h-cntx) {
    color: var(--color-fg-1);
    background: var(--color-bg-2);
  }
  .diff-viewer-host :global(.d2h-ins-change) {
    background: rgba(74, 222, 128, 0.18);
  }
  .diff-viewer-host :global(.d2h-del-change) {
    background: rgba(239, 90, 90, 0.18);
  }
  .diff-viewer-host :global(.d2h-tag) {
    background: var(--color-bg-3);
    color: var(--color-fg-2);
  }
</style>
