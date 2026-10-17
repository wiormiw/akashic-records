<script lang="ts">
	import { RealmModule } from '@akashic/lib/enums';
	import { invalidateAll } from '$app/navigation';
	import { MODULE_LABELS, membership } from '$lib/api/realms';
	import { SITE_NAME, SITE_URL } from '$lib/config';
	import { identityOf } from '$lib/realm-identity';
	import { countUp, revealOnView, staggerChildren } from '$lib/motion';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Empty from '$lib/ui/Empty.svelte';
	import EventCard from '$lib/ui/EventCard.svelte';
	import JobCard from '$lib/ui/JobCard.svelte';
	import ListingCard from '$lib/ui/ListingCard.svelte';
	import Section from '$lib/ui/Section.svelte';
	import Sigil from '$lib/ui/Sigil.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const realm = $derived(data.realm);
	const isMember = $derived(data.standing.role !== null);
	// One per module, because they no longer share a permission. Listings are open to any member;
	// jobs and events need a vouch. Showing a button whose form would 403 is worse than hiding it.
	const canList = $derived(data.standing.permissions.includes('realm.post'));
	const canPostJob = $derived(data.standing.permissions.includes('realm.post_job'));
	const canPostEvent = $derived(data.standing.permissions.includes('realm.post_event'));
	const canModerate = $derived(data.standing.permissions.includes('realm.moderate'));
	const identity = $derived(identityOf(realm.slug));

	/**
	 * What a visitor would actually be joining, counted from what is already on the page.
	 *
	 * Real numbers rather than a promise. "Sign in to join" asks somebody to pay before they know
	 * what for; "14 people, 3 events, 2 open briefs" is the same invitation with the answer
	 * attached, and it costs no extra request because every one of these was already loaded.
	 *
	 * Empty modules are dropped instead of shown as zero. A realm that has not scheduled anything
	 * yet is an ordinary state, and advertising it is an argument against joining.
	 */
	const inside = $derived(
		[
			{ count: realm.memberCount, one: 'member', many: 'members' },
			{ count: data.events.length, one: 'event', many: 'events' },
			{ count: data.jobs.length, one: 'open brief', many: 'open briefs' },
			{ count: data.listings.length, one: 'thing for sale', many: 'things for sale' },
		].filter((entry) => entry.count > 0),
	);

	/** Where sign-in should return a visitor to. */
	const backHere = $derived(`/realms/${realm.slug}`);

	// A preview, not the whole module. A realm with two hundred listings should still show its
	// events above the fold, and "see all" is one tap.
	const EVENTS = 4;
	const JOBS = 4;
	const LISTINGS = 4;

	let working = $state(false);
	let error = $state('');

	/**
	 * Joins or leaves, then reloads so every control reflects the new standing.
	 *
	 * @param action Which way to move.
	 */
	async function move(action: 'join' | 'leave'): Promise<void> {
		error = '';
		working = true;

		try {
			await membership(realm.slug, action);
			await invalidateAll();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = false;
		}
	}

	/**
	 * Where a posting's detail lives, for this particular reader.
	 *
	 * Three answers, and the middle one is the point:
	 *
	 * - a member goes to the posting;
	 * - a signed-out visitor goes to registration with the posting as their destination, so the
	 *   thing they were curious about is what they land on afterwards rather than the home page;
	 * - a signed-in non-member gets no link, because the alert above already tells them the one
	 *   thing they need to do and a second route into the same answer is noise.
	 *
	 * The previous version returned nothing for everybody who was not a member, which made a
	 * page of interesting postings entirely inert with no explanation of why.
	 */
	const detail = (kind: string, id: string): string | undefined => {
		const posting = `/realms/${realm.slug}/${kind}/${id}`;

		if (isMember) return posting;
		if (!data.signedIn) return `/register?next=${encodeURIComponent(posting)}`;

		return undefined;
	};
</script>

<svelte:head>
	<title>{realm.name} · {SITE_NAME}</title>
	<meta name="description" content={realm.description ?? `The ${realm.name} realm.`} />
	<link rel="canonical" href="{SITE_URL}/realms/{realm.slug}" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms" class="-ml-3">← All realms</Button>

<header class="mt-4" use:revealOnView={{ y: 16 }}>
	<!-- The realm's own colour, once, behind its name. Enough to make two realms feel like two
	     places without tinting the content underneath. -->
	<div
		class="flex flex-wrap items-start gap-4 rounded-app border border-border p-5"
		style="background: linear-gradient(120deg, {identity.wash}, transparent 70%)"
	>
		<Sigil slug={realm.slug} size={56} class="mt-0.5 shrink-0" />

		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-2">
				<h1 class="text-3xl font-semibold tracking-tight text-balance">{realm.name}</h1>
				{#if realm.category}
					<Badge variant="outline">{realm.category}</Badge>
				{/if}
			</div>

			{#if realm.description}
				<p class="mt-2 max-w-2xl leading-relaxed text-muted">{realm.description}</p>
			{/if}

			<div class="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
				<span class="tabular-nums">{realm.memberCount} members</span>
				{#each realm.modules as module (module)}
					<Badge variant="primary">{MODULE_LABELS[module] ?? 'Module'}</Badge>
				{/each}
			</div>
		</div>

		<div class="flex shrink-0 flex-wrap items-center gap-2">
			{#if !data.signedIn}
				<!-- Register first, sign in second. "Sign in to join" is the right words for the wrong
				     person: whoever is reading a realm page while signed out is usually somebody who
				     has no account at all, and it reads as a door they already failed to open. -->
				<Button href="/register?next={encodeURIComponent(backHere)}">Join {realm.name}</Button>
				<Button variant="ghost" href="/login?next={encodeURIComponent(backHere)}">Sign in</Button>
			{:else if isMember}
				<Button variant="outline" disabled={working} onclick={() => move('leave')}>
					{working ? 'Leaving…' : 'Leave realm'}
				</Button>
			{:else}
				<Button disabled={working} onclick={() => move('join')}>
					{working ? 'Joining…' : 'Join realm'}
				</Button>
			{/if}
		</div>
	</div>

	{#if isMember}
		<nav class="mt-3 flex flex-wrap gap-1">
			<Button variant="ghost" size="sm" href="/realms/{realm.slug}/members">Members</Button>
			{#if realm.modules.includes(RealmModule.election)}
				<Button variant="ghost" size="sm" href="/realms/{realm.slug}/election">
					Moderator seats
				</Button>
			{/if}
			{#if canModerate}
				<Button variant="ghost" size="sm" href="/realms/{realm.slug}/review">Review queue</Button>
			{/if}
		</nav>
	{/if}
</header>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}

{#if !data.signedIn}
	<!--
		The one panel on this page arguing for an account, and it argues with the realm's own
		numbers rather than with adjectives. Everything in it was already loaded for the sections
		below, so it costs nothing and it cannot describe a realm livelier than the one underneath
		it — if the counts are thin, the panel is honest and thin too.
	-->
	<section
		class="mt-6 overflow-hidden rounded-app border border-border"
		use:revealOnView={{ y: 20 }}
	>
		<div
			class="grid gap-6 p-6 sm:grid-cols-[1fr_auto] sm:items-center"
			style="background: linear-gradient(120deg, {identity.wash}, transparent 65%)"
		>
			<div class="min-w-0">
				<h2 class="text-xl font-semibold tracking-tight text-balance">
					You are looking at {realm.name} from the doorway.
				</h2>

				<p class="mt-2 max-w-prose leading-relaxed text-muted">
					Postings, replies and who is going are behind an account. It takes an email and a
					password, it is free, and you land back on this page.
				</p>

				{#if inside.length > 0}
					<ul
						class="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm"
						use:staggerChildren={{ each: 0.06 }}
					>
						{#each inside as entry (entry.one)}
							<li class="flex items-baseline gap-1.5">
								<span
									class="text-lg font-semibold tabular-nums"
									style="color: {identity.accent}"
									use:countUp={{ value: entry.count }}
								>
									{entry.count}
								</span>
								<span class="text-muted">{entry.count === 1 ? entry.one : entry.many}</span>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="flex flex-col gap-2 sm:w-44">
				<Button href="/register?next={encodeURIComponent(backHere)}">Create an account</Button>
				<Button variant="outline" href="/login?next={encodeURIComponent(backHere)}">
					I have one
				</Button>
			</div>
		</div>
	</section>
{:else if !isMember}
	<Alert variant="info" class="mt-6">
		Anyone can see what is happening here. <strong>Joining</strong> is what opens the detail behind each
		posting, and lets you post and RSVP.
	</Alert>
{/if}

{#if realm.modules.includes(RealmModule.events)}
	<Section
		title="Upcoming events"
		count={data.events.length}
		unit="scheduled"
		seeAll={data.events.length > EVENTS ? `/realms/${realm.slug}/events` : undefined}
		action={canPostEvent ? `/realms/${realm.slug}/events/new` : undefined}
		actionLabel="Schedule something"
	>
		{#if data.events.length === 0}
			<Empty
				title="Nothing scheduled yet"
				action={canPostEvent ? `/realms/${realm.slug}/events/new` : undefined}
				actionLabel="Schedule the first one"
			>
				Meetups, streams, swap days — anything the realm turns up to together.
			</Empty>
		{:else}
			<ul use:staggerChildren={{ each: 0.03 }} class="flex flex-col gap-2">
				{#each data.events.slice(0, EVENTS) as event (event.id)}
					<li><EventCard {event} href={detail('events', event.id)} /></li>
				{/each}
			</ul>
		{/if}
	</Section>
{/if}

{#if realm.modules.includes(RealmModule.jobs)}
	<Section
		title="Work"
		count={data.jobs.length}
		unit="open"
		seeAll={data.jobs.length > JOBS ? `/realms/${realm.slug}/jobs` : undefined}
		action={canPostJob ? `/realms/${realm.slug}/jobs/new` : undefined}
		actionLabel="Post work"
	>
		{#if data.jobs.length === 0}
			<Empty
				title="Nothing open right now"
				action={canPostJob ? `/realms/${realm.slug}/jobs/new` : undefined}
				actionLabel="Post the first brief"
			>
				Commissions, freelance, anything you would pay somebody here to do.
			</Empty>
		{:else}
			<ul use:staggerChildren={{ each: 0.03 }} class="flex flex-col gap-2">
				{#each data.jobs.slice(0, JOBS) as job (job.id)}
					<li><JobCard {job} href={detail('jobs', job.id)} /></li>
				{/each}
			</ul>
		{/if}
	</Section>
{/if}

{#if realm.modules.includes(RealmModule.market)}
	<Section
		title="Marketplace"
		count={data.listings.length}
		unit="listed"
		seeAll={data.listings.length > LISTINGS ? `/realms/${realm.slug}/listings` : undefined}
		action={canList ? `/realms/${realm.slug}/listings/new` : undefined}
		actionLabel="List something"
	>
		{#if data.listings.length === 0}
			<Empty
				title="Nothing for sale right now"
				action={canList ? `/realms/${realm.slug}/listings/new` : undefined}
				actionLabel="List the first thing"
			>
				The shelf you cannot fit anything else on, offered to people who want it.
			</Empty>
		{:else}
			<ul
				use:staggerChildren={{ each: 0.03 }}
				class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
			>
				{#each data.listings.slice(0, LISTINGS) as listing (listing.id)}
					<li><ListingCard {listing} slug={realm.slug} href={detail('listings', listing.id)} /></li>
				{/each}
			</ul>
		{/if}
	</Section>
{/if}

{#if !data.signedIn}
	<!-- The second and last ask, placed where somebody who scrolled the whole page ends up. The
	     panel at the top catches people who were already convinced; this catches the ones the
	     content convinced, and they are not the same people. -->
	<section
		class="mt-10 rounded-app border border-border p-6 text-center"
		use:revealOnView={{ y: 16 }}
	>
		<p class="text-lg font-medium text-balance">Everything above opens with an account.</p>
		<p class="mx-auto mt-1 max-w-prose text-sm leading-relaxed text-muted">
			One account covers every realm here, and your reading history is what the recommendations are
			built from.
		</p>
		<div class="mt-4 flex flex-wrap justify-center gap-2">
			<Button href="/register?next={encodeURIComponent(backHere)}">Join {realm.name}</Button>
			<Button variant="ghost" href="/realms">Look at the other realms</Button>
		</div>
	</section>
{/if}
