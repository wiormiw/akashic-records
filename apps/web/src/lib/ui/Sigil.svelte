<script lang="ts">
	import { identityOf, sigilRings } from '$lib/realm-identity';

	/**
	 * A realm's mark, drawn from its slug.
	 *
	 * Inline SVG rather than an image: it costs no request, scales to any size, and takes its
	 * colour from the realm's own hue so the mark and the page agree without a second source of
	 * truth. Decorative — the realm's name is always beside it — so it is hidden from readers.
	 */
	let {
		slug,
		size = 48,
		tint = undefined,
		class: className = '',
	}: {
		slug: string;
		size?: number;
		/**
		 * Draw in a given colour, keeping only the shape from `slug`.
		 *
		 * Used where many marks sit together — a grid of listings with no photographs. Varying the
		 * shape tells them apart; varying the hue as well turns a calm grid into confetti, and
		 * these are placeholders that must not outshout the real pictures beside them.
		 */
		tint?: string;
		class?: string;
	} = $props();

	const identity = $derived(identityOf(slug));
	const rings = $derived(sigilRings(identity.seed));
</script>

<svg
	viewBox="0 0 48 48"
	width={size}
	height={size}
	class={className}
	aria-hidden="true"
	style="color: {tint ?? identity.accent}"
>
	{#each rings as ring, index (index)}
		<circle
			cx="24"
			cy="24"
			r={ring.radius}
			fill="none"
			stroke="currentColor"
			stroke-width="0.6"
			opacity="0.25"
		/>
		{#each ring.marks as mark, markIndex (markIndex)}
			<circle cx={mark.x} cy={mark.y} r={mark.r} fill="currentColor" opacity={0.9 - index * 0.2} />
		{/each}
	{/each}
	<circle cx="24" cy="24" r="2.6" fill="currentColor" />
</svg>
