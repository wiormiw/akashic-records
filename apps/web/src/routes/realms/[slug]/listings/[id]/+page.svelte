<script lang="ts">
	import { LISTING_STATUS_LABELS, money, type ListingDetail } from '#lib/api/realms.ts';
	import { RoomSubject } from '@akashic/lib/enums';
	import { SITE_NAME } from '#lib/config.ts';
	import { identityOf } from '#lib/realm-identity.ts';
	import { revealOnView } from '#lib/motion.ts';
	import Badge from '#lib/ui/Badge.svelte';
	import Breadcrumbs from '#lib/ui/Breadcrumbs.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Interest from '#lib/ui/Interest.svelte';
	import MessageButton from '#lib/ui/MessageButton.svelte';
	import Sigil from '#lib/ui/Sigil.svelte';
	import Takedown from '#lib/ui/Takedown.svelte';
	import Thread from '#lib/ui/Thread.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const listing = $derived(data.posting as ListingDetail);
	const gone = $derived(listing.status !== 0);
	const canModerate = $derived(data.standing.permissions.includes('realm.moderate'));
	const identity = $derived(identityOf(data.realm.slug));
	const posted = $derived(
		new Date(listing.createdAt).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
		}),
	);
</script>

<svelte:head>
	<title>{listing.title} · {data.realm.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Breadcrumbs
	trail={[
		{ href: '/realms', label: 'Realms' },
		{ href: `/realms/${data.realm.slug}`, label: data.realm.name },
		{ href: `/realms/${data.realm.slug}/listings`, label: 'Marketplace' },
		{ label: listing.title },
	]}
/>

<article
	class="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
	use:revealOnView={{ y: 16 }}
>
	<div class="min-w-0">
		<!-- The picture is the thing being sold, so it leads rather than sitting in a sidebar. -->
		<div
			class="aspect-4/3 w-full overflow-hidden rounded-app border border-border"
			style={listing.imageUrl ? undefined : `background: ${identity.wash}`}
		>
			{#if listing.imageUrl}
				<img src={listing.imageUrl} alt="" class="h-full w-full object-cover" />
			{:else}
				<div class="flex h-full w-full items-center justify-center opacity-60">
					<Sigil slug={listing.id} size={96} />
				</div>
			{/if}
		</div>

		<div class="mt-5 flex flex-wrap items-center gap-2">
			<h1 class="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
				{listing.title}
			</h1>
			{#if gone}
				<Badge variant="accent">{LISTING_STATUS_LABELS[listing.status] ?? 'Unavailable'}</Badge>
			{/if}
		</div>

		<p class="mt-1 text-sm text-muted">
			Sold by <span class="text-text">{listing.sellerName}</span> · listed {posted}
		</p>

		<p class="mt-5 leading-relaxed whitespace-pre-line">{listing.description}</p>
	</div>

	<aside class="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:self-start">
		<Card class="p-4">
			<p class="text-2xl font-semibold tabular-nums" class:line-through={gone}>
				{money(listing.priceCents, listing.currency)}
			</p>
			<p class="mt-1 text-sm text-muted">
				{LISTING_STATUS_LABELS[listing.status] ?? 'Available'}
			</p>

			<div class="mt-4 flex flex-col gap-2">
				<MessageButton
					realmSlug={data.realm.slug}
					subjectKind={RoomSubject.listing}
					subjectId={listing.id}
					ownerId={listing.sellerId}
					ownerName={listing.sellerName}
					viewerId={data.user?.id}
				/>
			</div>

			<p class="mt-3 text-xs text-muted">
				Nothing here holds your money — this is a place to find each other, not an escrow.
			</p>
		</Card>

		<Interest
			slug={data.realm.slug}
			kind="listings"
			id={listing.id}
			ownerId={listing.sellerId}
			viewerId={data.user?.id}
			interested={listing.viewerInterested}
			settled={gone}
			verb="Mark sold to them"
		/>

		<Takedown
			slug={data.realm.slug}
			kind="listings"
			id={listing.id}
			ownerId={listing.sellerId}
			viewerId={data.user?.id}
			{canModerate}
			settled={gone}
		/>
	</aside>
</article>

<Thread
	slug={data.realm.slug}
	kind="listings"
	id={listing.id}
	enabled={listing.commentsEnabled && !gone}
	initial={data.thread}
	{canModerate}
/>
