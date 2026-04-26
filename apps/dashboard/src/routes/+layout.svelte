<script lang="ts">
  import '../app.css';
  import { page } from '$app/state';

  let { children } = $props();

  const navItems: { href: string; label: string }[] = [
    { href: '/projects', label: 'Projects' },
    { href: '/requirements', label: 'Requirements' },
    { href: '/gates', label: 'Gates' },
  ];

  function isActive(href: string): boolean {
    return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  }
</script>

<div class="min-h-screen bg-slate-50">
  <header class="border-b border-slate-200 bg-white">
    <div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
      <a href="/" class="flex items-center gap-2 text-slate-900">
        <span class="inline-block h-2.5 w-2.5 rounded-full bg-brand-500"></span>
        <span class="text-sm font-semibold tracking-tight">auto-finish</span>
      </a>
      <nav class="flex items-center gap-1">
        {#each navItems as item (item.href)}
          <a
            href={item.href}
            class={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              isActive(item.href)
                ? 'bg-brand-50 text-brand-700'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {item.label}
          </a>
        {/each}
      </nav>
    </div>
  </header>

  <main class="mx-auto max-w-6xl px-6 py-8">
    {@render children()}
  </main>
</div>
