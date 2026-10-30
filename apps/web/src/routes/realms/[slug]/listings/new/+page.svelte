<script lang="ts">
	import { goto } from '$app/navigation';
	import { createListing, money } from '#lib/api/realms.ts';
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
	let price = $state('');
	let imageUrl = $state('');
	let busy = $state(false);
	let error = $state('');

	// The API counts in the smallest unit; a seller types rupiah. Anything that is not a number
	// becomes NaN here and fails the check below rather than posting a silent zero.
	const priceCents = $derived(Math.round(Number(price.replace(/[^\d.]/gu, '')) * 100));
	const valid = $derived(
		title.trim().length >= 3 &&
			description.trim().length > 0 &&
			priceCents >= 0 &&
			Number.isFinite(priceCents),
	);

	/** Posts the listing and goes to it. */
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!valid || busy) return;

		busy = true;
		error = '';

		try {
			const { id } = await createListing(data.realm.slug, {
				title: title.trim(),
				description: description.trim(),
				priceCents,
				...(imageUrl === '' ? {} : { imageUrl }),
			});
			await goto(`/realms/${data.realm.slug}/listings/${id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not post that.';
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>List something · {data.realm.name} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{data.realm.slug}" class="-ml-3">
	← {data.realm.name}
</Button>

<h1 class="mt-4 text-2xl font-semibold tracking-tight">List something</h1>
<p class="mt-1 text-muted">Anyone in {data.realm.name} will see it.</p>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}

<Card class="mt-6 p-6">
	<form class="flex flex-col gap-4" onsubmit={submit}>
		<Field
			label="What is it"
			bind:value={title}
			maxlength="140"
			placeholder="Figure lot, mint boxes"
			required
		/>

		<label class="block">
			<span class="mb-1.5 block text-sm font-medium">Describe it</span>
			<textarea
				bind:value={description}
				rows="6"
				maxlength="8000"
				required
				placeholder="Condition, what is included, and how you would hand it over."
				class="w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
			></textarea>
		</label>

		<ImagePicker purpose="listings" policy={data.policy} bind:url={imageUrl} label="Picture" />

		<Field label="Price" bind:value={price} inputmode="decimal" placeholder="45000" required />
		<p class="-mt-2 text-xs text-muted">
			{price.trim() === '' || !Number.isFinite(priceCents)
				? 'In rupiah. Zero is fine — free to a good home is a real listing.'
				: `Buyers will see ${money(priceCents, 'IDR')}.`}
		</p>

		<div class="flex gap-2">
			<Button type="submit" disabled={!valid || busy}>
				{busy ? 'Posting…' : 'Post listing'}
			</Button>
			<Button variant="ghost" href="/realms/{data.realm.slug}">Cancel</Button>
		</div>
	</form>
</Card>
