<script lang="ts">
	import { identityOf } from '$lib/realm-identity';

	/**
	 * Somebody, at a glance.
	 *
	 * Falls back to a monogram on a colour derived from their id rather than to a generic grey
	 * silhouette: a roster where every row shows the same placeholder is harder to scan than one
	 * with none, because the eye stops at each identical shape.
	 */
	let {
		name,
		id,
		image = null,
		size = 36,
	}: { name: string; id: string; image?: string | null; size?: number } = $props();

	const identity = $derived(identityOf(id));
	// Grapheme-aware enough for the names this serves: a leading emoji or accented letter stays
	// whole rather than splitting into a replacement character.
	const initial = $derived([...(name.trim() || '?')][0]?.toUpperCase() ?? '?');
</script>

{#if image}
	<img
		src={image}
		alt=""
		width={size}
		height={size}
		loading="lazy"
		class="shrink-0 rounded-full border border-border object-cover"
		style="width: {size}px; height: {size}px"
	/>
{:else}
	<span
		aria-hidden="true"
		class="flex shrink-0 items-center justify-center rounded-full font-semibold"
		style="width: {size}px; height: {size}px; background: {identity.wash}; color: {identity.accent}; font-size: {Math.round(
			size * 0.42,
		)}px"
	>
		{initial}
	</span>
{/if}
