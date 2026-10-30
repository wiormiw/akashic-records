<script lang="ts">
	import { SITE_NAME } from '#lib/config.ts';
	import { staggerChildren } from '#lib/motion.ts';
	import Button from '#lib/ui/Button.svelte';
	import Empty from '#lib/ui/Empty.svelte';
	import ListingCard from '#lib/ui/ListingCard.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isMember = $derived(data.standing.role !== null);
	const canPost = $derived(data.standing.permissions.includes('realm.post'));

	// Sold and removed things stay visible but sort below what is still for sale — a marketplace
	// that hides them looks emptier than it is, and one that mixes them wastes a reader's time.
	const sorted = $derived(
		[...data.listings].sort((a, b) => (a.status === 0 ? 0 : 1) - (b.status === 0 ? 0 : 1)),
	);
	const open = $derived(data.listings.filter((listing) => listing.status === 0).length);
</script>

<svelte:head>
	<title>Marketplace · {data.realm.name} · {SITE_NAME}</title>
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{data.realm.slug}" class="-ml-3">
	← {data.realm.name}
</Button>

<div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
	<h1 class="text-2xl font-semibold tracking-tight">Marketplace</h1>
	<span class="text-sm text-muted">{open} for sale</span>
	{#if canPost}
		<Button
			variant="outline"
			size="sm"
			href="/realms/{data.realm.slug}/listings/new"
			class="ml-auto"
		>
			List something
		</Button>
	{/if}
</div>

{#if sorted.length === 0}
	<div class="mt-6">
		<Empty
			title="Nothing for sale right now"
			action={canPost ? `/realms/${data.realm.slug}/listings/new` : undefined}
			actionLabel="List the first thing"
		>
			The shelf you cannot fit anything else on, offered to people who want it.
		</Empty>
	</div>
{:else}
	<ul
		use:staggerChildren={{ each: 0.02 }}
		class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
	>
		{#each sorted as listing (listing.id)}
			<li>
				<ListingCard
					{listing}
					slug={data.realm.slug}
					href={isMember ? `/realms/${data.realm.slug}/listings/${listing.id}` : undefined}
				/>
			</li>
		{/each}
	</ul>
{/if}
