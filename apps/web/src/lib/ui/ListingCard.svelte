<script lang="ts">
	import { LISTING_STATUS_LABELS, money, type ListingTeaser } from '#lib/api/realms.ts';
	import { identityOf } from '#lib/realm-identity.ts';
	import Badge from './Badge.svelte';
	import Sigil from './Sigil.svelte';

	/**
	 * One thing for sale.
	 *
	 * The picture leads, because that is what somebody buying a figure is actually judging. A
	 * listing without one gets a mark drawn from its own id, on a wash of the realm's colour: the
	 * realm's own mark repeated down a grid would be six copies of the same thing, which reads as
	 * a rendering fault rather than as art. Fixed aspect ratio either way, so a grid of mixed
	 * listings does not jump around as images load.
	 */
	let {
		listing,
		slug,
		href = undefined,
	}: { listing: ListingTeaser; slug: string; href?: string } = $props();

	const gone = $derived(listing.status !== 0);
	const identity = $derived(identityOf(slug));
</script>

<svelte:element
	this={href ? 'a' : 'div'}
	{href}
	class="group block overflow-hidden rounded-app border border-border bg-surface transition-[border-color,transform] duration-150 hover:border-primary/60 focus-visible:border-primary/60 {href
		? 'active:scale-[0.995]'
		: ''}"
>
	<div
		class="relative aspect-4/3 overflow-hidden bg-surface-2"
		style={listing.imageUrl ? undefined : `background: ${identity.wash}`}
	>
		{#if listing.imageUrl}
			<img
				src={listing.imageUrl}
				alt=""
				loading="lazy"
				class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
			/>
		{:else}
			<!-- Shape from the listing so two placeholders differ; colour from the realm so a grid of
			     them stays one thing rather than becoming confetti. -->
			<div class="flex h-full w-full items-center justify-center opacity-60">
				<Sigil slug={listing.id} size={56} tint={identity.accent} />
			</div>
		{/if}

		{#if gone}
			<div class="absolute top-2 right-2">
				<Badge variant="accent">{LISTING_STATUS_LABELS[listing.status] ?? 'Unavailable'}</Badge>
			</div>
		{/if}
	</div>

	<div class="flex flex-col gap-1 p-3">
		<p class="line-clamp-2 text-sm leading-snug font-medium" class:opacity-60={gone}>
			{listing.title}
		</p>
		<p class="text-base font-semibold tabular-nums" class:line-through={gone}>
			{money(listing.priceCents, listing.currency)}
		</p>
	</div>
</svelte:element>
