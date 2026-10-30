<script lang="ts">
	import type { RsvpStatus } from '@akashic/lib/enums';
	import { invalidateAll } from '$app/navigation';
	import { RSVP_LABELS, rsvp } from '#lib/api/realms.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import { revealOnView } from '#lib/motion.ts';
	import Alert from '#lib/ui/Alert.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Breadcrumbs from '#lib/ui/Breadcrumbs.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Thread from '#lib/ui/Thread.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const event = $derived(data.event);
	const full = $derived(event.capacity !== null && event.goingCount >= event.capacity);
	const seatsLeft = $derived(event.capacity === null ? null : event.capacity - event.goingCount);

	let working = $state(false);
	let error = $state('');

	/**
	 * Records an answer, or withdraws it when the reader picks the one they already gave.
	 *
	 * Clicking your own answer again means "actually, ignore me" — which is not the same as
	 * declining, and gives the seat back rather than keeping it under a different label.
	 *
	 * @param status The answer clicked.
	 */
	async function answer(status: RsvpStatus): Promise<void> {
		error = '';
		working = true;

		try {
			await rsvp(data.realm.slug, event.id, event.yourRsvp === status ? null : status);
			await invalidateAll();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not record that.';
		} finally {
			working = false;
		}
	}

	/**
	 * Formats a timestamp for the header.
	 *
	 * @param iso ISO-8601 timestamp.
	 * @returns A full date and time.
	 */
	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			hour: '2-digit',
			minute: '2-digit',
		});
</script>

<svelte:head>
	<title>{event.title} · {data.realm.name}</title>
	<!-- Members-only, so it should never be indexed. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<Breadcrumbs
	trail={[
		{ href: '/realms', label: 'Realms' },
		{ href: `/realms/${data.realm.slug}`, label: data.realm.name },
		{ href: `/realms/${data.realm.slug}/events`, label: 'Events' },
		{ label: event.title },
	]}
/>

{#if event.imageUrl}
	<img
		src={event.imageUrl}
		alt=""
		class="mt-4 max-h-72 w-full rounded-app border border-border object-cover"
	/>
{/if}

<article
	class="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
	use:revealOnView={{ y: 16 }}
>
	<div>
		<h1 class="text-3xl font-semibold tracking-tight text-balance">{event.title}</h1>
		<p class="mt-2 text-muted">{when(event.startsAt)}</p>

		{#if event.location}
			<p class="mt-1 text-sm text-muted">{event.location}</p>
		{/if}

		<p class="mt-6 leading-relaxed whitespace-pre-line">{event.description}</p>

		<p class="mt-6 text-sm text-muted">Posted by {event.authorName}</p>
	</div>

	<aside class="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:self-start">
		<Card class="p-4">
			<h2 class="text-sm font-semibold">Are you going?</h2>

			<div class="mt-3 flex flex-wrap gap-1.5">
				{#each RSVP_LABELS as option (option.value)}
					<button
						type="button"
						disabled={working || (full && option.value === 0 && event.yourRsvp !== 0)}
						onclick={() => answer(option.value)}
						class="rounded-app border px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
						class:border-primary={event.yourRsvp === option.value}
						class:bg-primary={event.yourRsvp === option.value}
						class:text-primary-fg={event.yourRsvp === option.value}
						class:border-border={event.yourRsvp !== option.value}
						class:hover:bg-surface-2={event.yourRsvp !== option.value}
						title={event.yourRsvp === option.value ? 'Click again to withdraw' : option.label}
					>
						{option.label}
					</button>
				{/each}
			</div>

			{#if event.yourRsvp !== null}
				<p class="mt-2 text-xs text-muted">Click your answer again to withdraw it.</p>
			{/if}

			<p class="mt-3 text-sm text-muted">
				{event.goingCount} going{#if event.capacity}&nbsp;· {seatsLeft} of {event.capacity} left{/if}
			</p>

			{#if full && event.yourRsvp !== 0}
				<Alert variant="warning" class="mt-3">
					This one is full. Interested still puts you on the list if somebody drops out.
				</Alert>
			{/if}

			{#if error}
				<Alert variant="warning" class="mt-3" assertive>{error}</Alert>
			{/if}
		</Card>

		<Card class="p-4">
			<h2 class="text-sm font-semibold">Where</h2>
			<p class="mt-2 text-sm text-muted">
				{event.location ?? 'No location given — ask in the realm.'}
			</p>
			{#if event.endsAt}
				<p class="mt-3 text-xs text-muted">Ends {when(event.endsAt)}</p>
			{/if}
			<div class="mt-3">
				<Badge variant="outline">{data.realm.name}</Badge>
			</div>
		</Card>
	</aside>
</article>

<Thread
	slug={data.realm.slug}
	kind="events"
	id={event.id}
	enabled={event.commentsEnabled}
	initial={data.thread}
	canModerate={data.standing.permissions.includes('realm.moderate')}
/>
