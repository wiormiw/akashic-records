<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { listInterest, setInterest, settle, type Interest } from '#lib/api/realms.ts';
	import { openRoom } from '#lib/api/rooms.ts';
	import { RoomSubject } from '@akashic/lib/enums';
	import { goto } from '$app/navigation';
	import Alert from '#lib/ui/Alert.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';

	/**
	 * Both sides of a posting: putting a hand up, and choosing among the hands.
	 *
	 * Which half renders is decided by who is reading. The poster sees the applicants; everyone
	 * else sees their own hand, up or down. Nobody sees both, and a non-owner asking the API for
	 * the list is refused there too — this only decides what to draw.
	 */
	let {
		slug,
		kind,
		id,
		ownerId,
		viewerId,
		interested,
		settled,
		verb,
	}: {
		slug: string;
		kind: 'jobs' | 'listings';
		id: string;
		ownerId: string;
		viewerId: string | undefined;
		/** Whether the reader already has their hand up, from the posting itself. */
		interested: boolean;
		/** Filled, or sold. Settled postings take no more applicants and cannot be settled twice. */
		settled: boolean;
		/** What the poster's button says. */
		verb: string;
	} = $props();

	const mine = $derived(viewerId === ownerId);

	let applicants = $state<Interest[]>([]);
	let chosenId = $state('');
	let loaded = $state(false);
	let note = $state('');
	let busy = $state('');
	let error = $state('');

	// The poster's list is worth one request; everyone else has their own state already.
	$effect(() => {
		if (!mine || loaded) return;

		loaded = true;
		listInterest(slug, kind, id).then((rows) => (applicants = rows));
	});

	/** Puts the reader's hand up, or takes it down. */
	async function toggle(): Promise<void> {
		busy = 'self';
		error = '';

		try {
			await setInterest(slug, kind, id, interested ? null : note.trim());
			note = '';
			await invalidateAll();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not do that.';
		} finally {
			busy = '';
		}
	}

	/** Chooses one applicant, which closes the posting to the rest. */
	async function choose(applicant: Interest): Promise<void> {
		busy = applicant.id;
		error = '';

		try {
			await settle(slug, kind, id, applicant.userId);
			chosenId = applicant.userId;
			await invalidateAll();
			applicants = await listInterest(slug, kind, id);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not do that.';
		} finally {
			busy = '';
		}
	}

	/** Opens the private room with one applicant. */
	async function message(applicant: Interest): Promise<void> {
		busy = applicant.id;

		try {
			const { id: roomId } = await openRoom(
				slug,
				kind === 'jobs' ? RoomSubject.job : RoomSubject.listing,
				id,
				applicant.userId,
			);
			await goto(`/rooms/${roomId}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not open that conversation.';
			busy = '';
		}
	}
</script>

{#if error}
	<Alert variant="warning" assertive>{error}</Alert>
{/if}

{#if mine}
	<Card class="p-4">
		<h2 class="text-sm font-semibold">
			{applicants.length === 0 ? 'Nobody yet' : `${applicants.length} interested`}
		</h2>

		{#if applicants.length === 0}
			<p class="mt-2 text-xs text-muted">
				You will see everyone who puts their hand up, along with whatever they said.
			</p>
		{:else}
			<ul class="mt-3 flex flex-col gap-3">
				{#each applicants as applicant (applicant.id)}
					<li class="border-t border-border pt-3 first:border-0 first:pt-0">
						<p class="text-sm font-medium">
							{applicant.userName}
							{#if applicant.status === 2 || applicant.userId === chosenId}
								<Badge variant="primary" class="ml-1">chosen</Badge>
							{/if}
						</p>
						{#if applicant.note}
							<p class="mt-1 text-sm whitespace-pre-line text-muted">{applicant.note}</p>
						{/if}

						<div class="mt-2 flex gap-2">
							<Button size="sm" variant="ghost" onclick={() => message(applicant)}>Message</Button>
							{#if !settled}
								<Button
									size="sm"
									variant="outline"
									disabled={busy !== ''}
									onclick={() => choose(applicant)}
								>
									{busy === applicant.id ? 'Working…' : verb}
								</Button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if settled}
			<p class="mt-3 text-xs text-muted">
				Settled. Everyone else's interest was closed at the same moment, so nobody is left waiting
				on an answer that is not coming.
			</p>
		{/if}
	</Card>
{:else if viewerId && !settled}
	<Card class="p-4">
		{#if interested}
			<div class="flex flex-wrap items-center gap-2">
				<Badge variant="primary">Hand up</Badge>
				<span class="text-sm text-muted">The poster can see you.</span>
			</div>
			<Button size="sm" variant="ghost" class="mt-3 -ml-3" disabled={busy !== ''} onclick={toggle}>
				{busy ? 'Working…' : 'Take it back'}
			</Button>
		{:else}
			<h2 class="text-sm font-semibold">
				{kind === 'jobs' ? 'Interested in this work?' : 'Want this?'}
			</h2>
			<textarea
				bind:value={note}
				rows="3"
				maxlength="1000"
				placeholder={kind === 'jobs'
					? 'Anything the poster should know — rates, timeline, where your work lives.'
					: 'Anything the seller should know — when you could collect, what you would pay.'}
				class="mt-2 w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
			></textarea>
			<Button size="sm" class="mt-2" disabled={busy !== ''} onclick={toggle}>
				{busy ? 'Working…' : kind === 'jobs' ? 'Apply' : "I'll take it"}
			</Button>
			<p class="mt-2 text-xs text-muted">
				Optional note, and you can take it back later. This is not a message — it is what the poster
				chooses from.
			</p>
		{/if}
	</Card>
{/if}
