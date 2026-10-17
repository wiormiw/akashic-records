<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	/**
	 * What a module says when it holds nothing.
	 *
	 * An empty section is the most common state a young realm is in, so it is worth more than one
	 * grey sentence: it says what belongs here, and offers the action to somebody who may take it.
	 */
	let {
		title,
		action = undefined,
		actionLabel = undefined,
		children = undefined,
	}: {
		title: string;
		action?: string;
		actionLabel?: string;
		children?: Snippet;
	} = $props();
</script>

<div
	class="flex flex-col items-center gap-2 rounded-app border border-dashed border-border px-6 py-10 text-center"
>
	<p class="font-medium">{title}</p>
	{#if children}
		<p class="max-w-md text-sm text-muted">{@render children()}</p>
	{/if}
	{#if action && actionLabel}
		<Button size="sm" href={action} class="mt-2">{actionLabel}</Button>
	{/if}
</div>
