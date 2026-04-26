<script lang="ts">
  const links: { href: string; label: string; description: string }[] = [
    {
      href: '/projects',
      label: 'Projects',
      description: 'Configured projects and their repos.',
    },
    {
      href: '/requirements',
      label: 'Requirements',
      description: 'Live board of in-flight, queued, and completed requirements.',
    },
    {
      href: '/gates',
      label: 'Gates',
      description: 'Awaiting human review — design docs and PR-ready output.',
    },
  ];
</script>

<section class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight text-slate-900">
      auto-finish dashboard
    </h1>
    <p class="mt-2 max-w-2xl text-sm text-slate-600">
      Concurrent AI-driven delivery pipelines. Operators schedule and review;
      Claude Code subprocesses do the work in isolated sandboxes.
    </p>
  </div>

  <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each links as link (link.href)}
      <li>
        <a
          href={link.href}
          class="block h-full rounded-lg border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-500 hover:shadow"
        >
          <h2 class="text-sm font-semibold text-slate-900">{link.label}</h2>
          <p class="mt-1 text-sm text-slate-600">{link.description}</p>
        </a>
      </li>
    {/each}
  </ul>
</section>
