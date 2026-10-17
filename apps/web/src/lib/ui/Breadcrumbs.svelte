<script lang="ts">
	/**
	 * Where this page sits.
	 *
	 * A single back link tells a reader how to leave; a trail tells them where they are. On a
	 * posting three levels deep — realm, module, thing — that difference is the difference between
	 * browsing and being lost.
	 */
	let { trail }: { trail: { href?: string; label: string }[] } = $props();
</script>

<nav aria-label="Breadcrumb" class="-ml-1 flex flex-wrap items-center gap-1 text-sm text-muted">
	{#each trail as step, index (step.label)}
		{#if index > 0}
			<span aria-hidden="true" class="opacity-50">/</span>
		{/if}
		{#if step.href}
			<a href={step.href} class="rounded-app px-1 py-0.5 transition-colors hover:text-text">
				{step.label}
			</a>
		{:else}
			<span aria-current="page" class="px-1 py-0.5 text-text">{step.label}</span>
		{/if}
	{/each}
</nav>
