<script lang="ts">
	import type { EventTeaser } from '#lib/api/realms.ts';
	import Badge from './Badge.svelte';

	/**
	 * One event.
	 *
	 * The date is a block rather than a sentence, because the question somebody scanning a list of
	 * events is asking is "when", and a column of aligned day numbers answers it without reading.
	 */
	let { event, href = undefined }: { event: EventTeaser; href?: string } = $props();

	const when = $derived(new Date(event.startsAt));
	const full = $derived(event.capacity !== null && event.goingCount >= event.capacity);
	const past = $derived(when.getTime() < Date.now());
</script>

<svelte:element
	this={href ? 'a' : 'div'}
	{href}
	class="flex items-center gap-4 rounded-app border border-border bg-surface p-3 transition-[border-color] duration-150 hover:border-primary/60 focus-visible:border-primary/60"
>
	<div
		class="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-app bg-surface-2 leading-none"
		class:opacity-50={past}
	>
		<span class="text-[0.65rem] font-medium tracking-wide text-muted uppercase">
			{when.toLocaleDateString(undefined, { month: 'short' })}
		</span>
		<span class="text-xl font-semibold tabular-nums">
			{when.toLocaleDateString(undefined, { day: 'numeric' })}
		</span>
	</div>

	<div class="min-w-0 flex-1">
		<p class="truncate font-medium">{event.title}</p>
		<p class="mt-0.5 text-xs text-muted">
			{when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
			{#if past}· already happened{/if}
		</p>
	</div>

	{#if event.capacity !== null}
		<Badge variant={full ? 'accent' : 'neutral'}>
			{event.goingCount}/{event.capacity}
		</Badge>
	{:else}
		<Badge>{event.goingCount} going</Badge>
	{/if}
</svelte:element>
