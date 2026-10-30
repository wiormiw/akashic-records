<script lang="ts">
	import { SITE_NAME } from '#lib/config.ts';
	import { staggerChildren } from '#lib/motion.ts';
	import Button from '#lib/ui/Button.svelte';
	import Empty from '#lib/ui/Empty.svelte';
	import EventCard from '#lib/ui/EventCard.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isMember = $derived(data.standing.role !== null);
	const canPost = $derived(data.standing.permissions.includes('realm.post_event'));
</script>

<svelte:head>
	<title>Events · {data.realm.name} · {SITE_NAME}</title>
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{data.realm.slug}" class="-ml-3">
	← {data.realm.name}
</Button>

<div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
	<h1 class="text-2xl font-semibold tracking-tight">Events</h1>
	<span class="text-sm text-muted">{data.events.length} scheduled</span>
	{#if canPost}
		<Button variant="outline" size="sm" href="/realms/{data.realm.slug}/events/new" class="ml-auto">
			Schedule something
		</Button>
	{/if}
</div>

{#if data.events.length === 0}
	<div class="mt-6">
		<Empty
			title="Nothing scheduled yet"
			action={canPost ? `/realms/${data.realm.slug}/events/new` : undefined}
			actionLabel="Schedule the first one"
		>
			Meetups, streams, swap days — anything the realm turns up to together.
		</Empty>
	</div>
{:else}
	<ul use:staggerChildren={{ each: 0.02 }} class="mt-6 flex flex-col gap-2">
		{#each data.events as event (event.id)}
			<li>
				<EventCard
					{event}
					href={isMember ? `/realms/${data.realm.slug}/events/${event.id}` : undefined}
				/>
			</li>
		{/each}
	</ul>
{/if}
