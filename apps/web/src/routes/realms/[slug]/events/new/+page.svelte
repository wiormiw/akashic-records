<script lang="ts">
	import { goto } from '$app/navigation';
	import { createEvent } from '#lib/api/realms.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import Alert from '#lib/ui/Alert.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Field from '#lib/ui/Field.svelte';
	import ImagePicker from '#lib/ui/ImagePicker.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let title = $state('');
	let description = $state('');
	let startsAt = $state('');
	let endsAt = $state('');
	let location = $state('');
	let capacity = $state('');
	let imageUrl = $state('');
	let busy = $state(false);
	let error = $state('');

	const seats = $derived(capacity.trim() === '' ? undefined : Number(capacity));
	const valid = $derived(
		title.trim().length >= 3 &&
			description.trim().length > 0 &&
			startsAt !== '' &&
			(seats === undefined || (Number.isInteger(seats) && seats >= 1)),
	);

	/**
	 * Turns what `datetime-local` gives back into an instant.
	 *
	 * The control has no timezone, so the string is read in the poster's own — which is what they
	 * meant when they typed it.
	 *
	 * @param local A `YYYY-MM-DDTHH:mm` string.
	 * @returns The same moment, ISO-8601 with an offset.
	 */
	const instant = (local: string): string => new Date(local).toISOString();

	/** Posts the event and goes to it. */
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!valid || busy) return;

		busy = true;
		error = '';

		try {
			const { id } = await createEvent(data.realm.slug, {
				title: title.trim(),
				description: description.trim(),
				startsAt: instant(startsAt),
				...(endsAt === '' ? {} : { endsAt: instant(endsAt) }),
				...(location.trim() === '' ? {} : { location: location.trim() }),
				...(seats === undefined ? {} : { capacity: seats }),
				...(imageUrl === '' ? {} : { imageUrl }),
			});
			await goto(`/realms/${data.realm.slug}/events/${id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not post that.';
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Schedule something · {data.realm.name} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{data.realm.slug}" class="-ml-3">
	← {data.realm.name}
</Button>

<h1 class="mt-4 text-2xl font-semibold tracking-tight">Schedule something</h1>
<p class="mt-1 text-muted">Everyone in {data.realm.name} can RSVP.</p>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}

<Card class="mt-6 p-6">
	<form class="flex flex-col gap-4" onsubmit={submit}>
		<Field
			label="What is happening"
			bind:value={title}
			maxlength="140"
			placeholder="Figure swap and coffee"
			required
		/>

		<label class="block">
			<span class="mb-1.5 block text-sm font-medium">Details</span>
			<textarea
				bind:value={description}
				rows="6"
				maxlength="4000"
				required
				placeholder="What to expect, what to bring, and anything worth knowing before saying yes."
				class="w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
			></textarea>
		</label>

		<ImagePicker purpose="events" policy={data.policy} bind:url={imageUrl} label="Banner" />

		<div class="grid gap-4 sm:grid-cols-2">
			<Field label="Starts" type="datetime-local" bind:value={startsAt} required />
			<Field label="Ends" type="datetime-local" bind:value={endsAt} />
		</div>

		<Field label="Where" bind:value={location} maxlength="200" placeholder="Braga, Bandung" />

		<Field
			label="Seats"
			bind:value={capacity}
			inputmode="numeric"
			placeholder="Leave blank for unlimited"
		/>
		<p class="-mt-2 text-xs text-muted">
			A capacity is a hard stop: once it fills, the next RSVP is refused rather than queued.
		</p>

		<div class="flex gap-2">
			<Button type="submit" disabled={!valid || busy}>{busy ? 'Posting…' : 'Schedule it'}</Button>
			<Button variant="ghost" href="/realms/{data.realm.slug}">Cancel</Button>
		</div>
	</form>
</Card>
