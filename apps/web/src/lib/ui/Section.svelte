<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	/**
	 * One module's block on a realm's page.
	 *
	 * The same shape for events, jobs and marketplace, because they answer the same question —
	 * what is happening here — and giving each its own layout would make a reader learn three
	 * things instead of one.
	 */
	let {
		title,
		count,
		unit,
		seeAll = undefined,
		action = undefined,
		actionLabel = undefined,
		children,
	}: {
		title: string;
		count: number;
		/** What is being counted, e.g. `listed`. Pluralisation is the caller's business. */
		unit: string;
		/** Where the full list lives, shown only when there is more than the preview holds. */
		seeAll?: string;
		/** Where posting happens, shown only to somebody allowed to post. */
		action?: string;
		actionLabel?: string;
		children: Snippet;
	} = $props();
</script>

<section class="mt-10">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<h2 class="text-lg font-semibold tracking-tight">{title}</h2>
		<span class="text-sm text-muted">{count} {unit}</span>

		<div class="ml-auto flex items-center gap-1">
			{#if seeAll}
				<Button variant="ghost" size="sm" href={seeAll}>See all</Button>
			{/if}
			{#if action && actionLabel}
				<Button variant="outline" size="sm" href={action}>{actionLabel}</Button>
			{/if}
		</div>
	</div>

	<div class="mt-4">
		{@render children()}
	</div>
</section>
