<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';

  let { children } = $props();

  const navItems: { href: string; label: string }[] = [
    { href: '/projects', label: '项目' },
    { href: '/requirements', label: '需求' },
    { href: '/gates', label: '关卡' },
  ];

  function isActive(href: string): boolean {
    return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  }
</script>

<div class="min-h-screen">
  <header class="border-b border-[var(--color-line)] bg-[var(--color-bg-1)]">
    <div class="mx-auto flex h-12 max-w-6xl items-center gap-6 px-6">
      <a href="/" class="flex items-center gap-2 text-sm font-semibold">
        <span class="block h-2 w-2 rounded-full bg-[var(--color-accent)]"></span>
        <span>auto-finish</span>
      </a>

      <nav class="flex items-center gap-1">
        {#each navItems as item (item.href)}
          <a href={item.href} class={`tab ${isActive(item.href) ? 'tab-active' : ''}`}>
            {item.label}
          </a>
        {/each}
      </nav>

      <div class="ml-auto flex items-center gap-3 text-xs text-[var(--color-fg-2)]">
        <span class="flex items-center gap-1.5">
          <span class="dot pulse bg-[var(--color-success)]"></span>
          <span>orchestrator 在线</span>
        </span>
      </div>
    </div>
  </header>

  <main class="mx-auto max-w-6xl px-6 py-6">
    {@render children()}
  </main>
</div>
