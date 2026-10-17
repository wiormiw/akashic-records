<script lang="ts">
	import { SITE_NAME, SITE_URL } from '$lib/config';
	import { MODULE_LABELS } from '$lib/api/realms';
	import { revealOnView, staggerChildren, tilt } from '$lib/motion';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import MeteorShower from '$lib/ui/MeteorShower.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{SITE_NAME} · communities for fans</title>
	<meta
		name="description"
		content="Realms: fan communities with their own members, roles and rules, where jobs, events and a marketplace answer to the people they are for."
	/>
	<link rel="canonical" href="{SITE_URL}/" />
	<meta property="og:title" content="{SITE_NAME} · communities for fans" />
	<meta property="og:type" content="website" />
</svelte:head>

<!-- `isolate` makes this a stacking context, so the decorative layer paints behind the content. -->
<section class="relative isolate overflow-x-clip py-20 sm:py-28">
	<div aria-hidden="true" class="pointer-events-none absolute inset-0 z-0">
		<MeteorShower />
	</div>

	<div class="relative z-10 max-w-3xl" use:revealOnView={{ y: 18 }}>
		<h1 class="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
			The taste is yours. <span class="text-accent">The scene is shared.</span>
		</h1>
		<p class="mt-5 max-w-2xl text-lg text-muted">
			A realm is a community with its own members, its own roles and its own rules. Jobs, events and
			a marketplace run inside each one, so a commission, a meetup or a sale answers to the people
			it is for.
		</p>
		<div class="mt-8 flex flex-wrap gap-3">
			<Button href="/realms" size="md">Explore the realms</Button>
			{#if !data.user}
				<Button href="/register" variant="outline">Create account</Button>
			{/if}
		</div>
	</div>
</section>

{#if data.realms.length > 0}
	<section class="pb-16" aria-label="Realms">
		<ul use:staggerChildren={{ each: 0.05 }} class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.realms as realm (realm.id)}
				<li>
					<div use:tilt={{ max: 4 }} class="h-full will-change-transform">
						<Card class="flex h-full flex-col p-5">
							<div class="flex items-baseline gap-2">
								<h3 class="font-semibold">{realm.name}</h3>
								<span class="ml-auto font-mono text-xs text-muted">
									{realm.memberCount}
									{realm.memberCount === 1 ? 'member' : 'members'}
								</span>
							</div>

							{#if realm.description}
								<p class="mt-2 text-sm leading-relaxed text-muted">{realm.description}</p>
							{/if}

							<ul class="mt-4 flex flex-wrap gap-1.5">
								{#each realm.modules as module (module)}
									<li><Badge variant="outline">{MODULE_LABELS[module] ?? 'Module'}</Badge></li>
								{/each}
							</ul>

							<div class="mt-auto pt-4">
								<Button href="/realms/{realm.slug}" variant="outline" size="sm">Look inside</Button>
							</div>
						</Card>
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<!-- One card per module: each is a different promise. -->
<section class="grid gap-3 border-t border-border py-16 lg:grid-cols-3">
	<div use:revealOnView={{ delay: 0 }}>
		<Card class="flex h-full flex-col p-5">
			<p class="font-mono text-xs tracking-widest text-muted uppercase">Events</p>
			<h3 class="mt-2 text-lg font-semibold text-balance">Show up somewhere.</h3>
			<p class="mt-2 text-sm leading-relaxed text-muted">
				Meetups, locals, screenings. RSVP with a real capacity, so a room that fits twelve says
				twelve rather than finding out on the night.
			</p>

			{#if data.events.length > 0 && data.eventsRealm}
				<ul class="mt-4 flex flex-col gap-2 border-t border-border pt-4">
					{#each data.events as event (event.id)}
						<li class="flex items-baseline gap-2 text-sm">
							<a href="/realms/{data.eventsRealm}/events/{event.id}" class="hover:text-primary">
								{event.title}
							</a>
							<span class="ml-auto font-mono text-xs whitespace-nowrap text-muted">
								{new Date(event.startsAt).toLocaleDateString(undefined, {
									day: 'numeric',
									month: 'short',
								})}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="mt-4 border-t border-border pt-4 text-xs text-muted">
					Nothing scheduled yet. The first one is yours to post.
				</p>
			{/if}
		</Card>
	</div>

	<div use:revealOnView={{ delay: 0.06 }}>
		<Card class="flex h-full flex-col p-5">
			<p class="font-mono text-xs tracking-widest text-muted uppercase">Jobs</p>
			<h3 class="mt-2 text-lg font-semibold text-balance">
				Get paid for the thing you already do.
			</h3>
			<p class="mt-2 text-sm leading-relaxed text-muted">
				Commissions, freelance and full-time, posted inside the community that understands the
				brief. Vouched members post; the poster picks who they hire.
			</p>
		</Card>
	</div>

	<div use:revealOnView={{ delay: 0.12 }}>
		<Card class="flex h-full flex-col p-5">
			<p class="font-mono text-xs tracking-widest text-muted uppercase">Marketplace</p>
			<h3 class="mt-2 text-lg font-semibold text-balance">Sell it to someone who wants it.</h3>
			<p class="mt-2 text-sm leading-relaxed text-muted">
				Figures, cards, fabric, doujin. Listings sit in the realm they belong to, and the
				conversation about a sale is end-to-end encrypted.
			</p>
		</Card>
	</div>
</section>
