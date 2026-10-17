<script lang="ts">
	import { RealmModule } from '@akashic/lib/enums';
	import { goto } from '$app/navigation';
	import { MODULE_LABELS } from '$lib/api/realms';
	import { propose } from '$lib/api/proposals';
	import { SITE_NAME } from '$lib/config';
	import { identityOf } from '$lib/realm-identity';
	import Alert from '$lib/ui/Alert.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Field from '$lib/ui/Field.svelte';
	import Sigil from '$lib/ui/Sigil.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let name = $state('');
	let slug = $state('');
	let description = $state('');
	let category = $state('');
	let rationale = $state('');
	let modules = $state<number[]>([RealmModule.events]);
	let touchedSlug = $state(false);
	let busy = $state(false);
	let error = $state('');

	/**
	 * Turns a name into a usable slug.
	 *
	 * @param value What they typed as the name.
	 * @returns Lowercase words joined by single dashes.
	 *
	 * @example
	 * slugify('TCG Traders'); // "tcg-traders"
	 */
	const slugify = (value: string): string =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, '-')
			.replace(/^-|-$/gu, '')
			.slice(0, 48);

	// Follows the name until somebody edits it themselves, at which point it is theirs.
	$effect(() => {
		if (!touchedSlug) slug = slugify(name);
	});

	/** The API's own floor, repeated here so the button disables rather than the request failing. */
	const RATIONALE_MIN = 40;

	const valid = $derived(
		name.trim().length >= 2 &&
			/^[a-z0-9-]{2,48}$/u.test(slug) &&
			rationale.trim().length >= RATIONALE_MIN,
	);

	const preview = $derived(identityOf(slug || 'realm'));

	/** Switches a module on or off. */
	function toggle(module: number): void {
		modules = modules.includes(module)
			? modules.filter((value) => value !== module)
			: [...modules, module];
	}

	/** Files the proposal and shows the reader where to watch for an answer. */
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!valid || busy) return;

		busy = true;
		error = '';

		try {
			await propose({
				slug,
				name: name.trim(),
				...(description.trim() === '' ? {} : { description: description.trim() }),
				...(category.trim() === '' ? {} : { category: category.trim() }),
				modules,
				rationale: rationale.trim(),
			});

			await goto('/realms/proposals');
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not send that proposal.';
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Propose a realm · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms" class="-ml-3">← All realms</Button>

<h1 class="mt-4 text-2xl font-semibold tracking-tight">Propose a realm</h1>
<p class="mt-1 max-w-2xl text-muted">
	Realms are not created on the spot. An empty one is worse than none: a directory full of
	communities with a single member teaches a visitor that nothing happens here. Tell us who this is
	for, and if it is approved you will be its first admin.
</p>

{#if data.pending}
	<!-- One pending proposal per account. Saying so here beats letting them write four paragraphs
	     and then be refused by the API for a reason they could have known first. -->
	<Alert variant="info" class="mt-6">
		You already have a proposal waiting: <strong>{data.pending.name}</strong>. Wait for a decision
		on that one before sending another.
		<a href="/realms/proposals" class="ml-1 underline underline-offset-4">See it</a>.
	</Alert>
{:else}
	{#if error}
		<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
	{/if}

	<Card class="mt-6 p-6">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<div class="flex items-center gap-4">
				<!-- The mark is derived from the slug, so it moves as they type. Nothing to choose, and
				     the realm has a face before it has a single member. -->
				<div
					class="flex h-20 w-20 shrink-0 items-center justify-center rounded-app border border-border"
					style="background: {preview.wash}"
				>
					<Sigil slug={slug || 'realm'} size={52} />
				</div>
				<p class="text-sm text-muted">
					Every realm gets its own mark and colour, drawn from its address. This is yours.
				</p>
			</div>

			<Field label="Name" bind:value={name} maxlength="80" placeholder="TCG Traders" required />

			<label class="block">
				<span class="mb-1.5 block text-sm font-medium">Address</span>
				<div class="flex items-center gap-1 text-sm">
					<span class="text-muted">/realms/</span>
					<input
						bind:value={slug}
						oninput={() => (touchedSlug = true)}
						maxlength="48"
						required
						class="h-10 flex-1 rounded-app border border-border bg-surface px-3 text-sm text-text placeholder:text-muted"
					/>
				</div>
				<span class="mt-1 block text-xs text-muted">
					Lowercase letters, numbers and dashes. Checked again when the proposal is decided, because
					somebody else may take the name while it waits.
				</span>
			</label>

			<label class="block">
				<span class="mb-1.5 block text-sm font-medium">
					Who is it for, and what would be posted there?
				</span>
				<textarea
					bind:value={rationale}
					rows="4"
					maxlength="1000"
					required
					placeholder="The part somebody actually reads before deciding."
					class="w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
				></textarea>
				<span class="mt-1 block text-xs text-muted">
					<!-- Shown as a countdown rather than a rule, because a rule reads as an obstacle and a
					     countdown reads as a form being filled in. -->
					{#if rationale.trim().length >= RATIONALE_MIN}
						This is what an admin reads to decide.
					{:else}
						{RATIONALE_MIN - rationale.trim().length} more characters. This is the only part that decides
						it.
					{/if}
				</span>
			</label>

			<label class="block">
				<span class="mb-1.5 block text-sm font-medium">Short description</span>
				<textarea
					bind:value={description}
					rows="2"
					maxlength="500"
					placeholder="One line, shown on the realm's card."
					class="w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
				></textarea>
			</label>

			<Field
				label="Category"
				bind:value={category}
				maxlength="40"
				placeholder="anime, cosplay, tcg…"
			/>

			<fieldset>
				<legend class="mb-1.5 text-sm font-medium">What it would run</legend>
				<div class="flex flex-wrap gap-2">
					{#each [RealmModule.events, RealmModule.jobs, RealmModule.market, RealmModule.election] as module (module)}
						{@const on = modules.includes(module)}
						<button
							type="button"
							onclick={() => toggle(module)}
							aria-pressed={on}
							class="rounded-full border px-3 py-1.5 text-sm transition-colors"
							class:border-primary={on}
							class:bg-primary={on}
							class:text-primary-fg={on}
							class:border-border={!on}
							class:text-muted={!on}
						>
							{MODULE_LABELS[module] ?? 'Module'}
						</button>
					{/each}
				</div>
				<p class="mt-1.5 text-xs text-muted">
					Anything off stays off until you switch it on. <strong>Elections</strong> lets members upvote
					each other for the moderator seats instead of you appointing them.
				</p>
			</fieldset>

			<div class="flex gap-2">
				<Button type="submit" disabled={!valid || busy}>{busy ? 'Sending…' : 'Send it'}</Button>
				<Button variant="ghost" href="/realms">Cancel</Button>
			</div>
		</form>
	</Card>
{/if}
