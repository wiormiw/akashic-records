<script lang="ts">
	import { goto } from '$app/navigation';
	import { createJob, JOB_TYPE_LABELS, money } from '#lib/api/realms.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import Alert from '#lib/ui/Alert.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Field from '#lib/ui/Field.svelte';
	import Select from '#lib/ui/Select.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let title = $state('');
	let description = $state('');
	let type = $state('0');
	let budget = $state('');
	let hiringFlow = $state('');
	let busy = $state(false);
	let error = $state('');

	const types = Object.entries(JOB_TYPE_LABELS).map(([value, label]) => ({ value, label }));

	// Blank means "ask", which is a real answer for commission work nobody has scoped yet.
	const budgetCents = $derived(
		budget.trim() === '' ? undefined : Math.round(Number(budget.replace(/[^\d.]/gu, '')) * 100),
	);
	const valid = $derived(
		title.trim().length >= 3 &&
			description.trim().length > 0 &&
			(budgetCents === undefined || Number.isFinite(budgetCents)),
	);

	/** Posts the job and goes to it. */
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!valid || busy) return;

		busy = true;
		error = '';

		try {
			const { id } = await createJob(data.realm.slug, {
				title: title.trim(),
				description: description.trim(),
				type: Number(type),
				...(budgetCents === undefined ? {} : { budgetCents }),
				...(hiringFlow.trim() === '' ? {} : { hiringFlow: hiringFlow.trim() }),
			});
			await goto(`/realms/${data.realm.slug}/jobs/${id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not post that.';
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Post work · {data.realm.name} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{data.realm.slug}" class="-ml-3">
	← {data.realm.name}
</Button>

<h1 class="mt-4 text-2xl font-semibold tracking-tight">Post work</h1>
<p class="mt-1 text-muted">Anyone in {data.realm.name} can apply.</p>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}

<Card class="mt-6 p-6">
	<form class="flex flex-col gap-4" onsubmit={submit}>
		<Field
			label="What needs doing"
			bind:value={title}
			maxlength="140"
			placeholder="Cover illustration, one character"
			required
		/>

		<label class="block">
			<span class="mb-1.5 block text-sm font-medium">The brief</span>
			<textarea
				bind:value={description}
				rows="8"
				maxlength="8000"
				required
				placeholder="What you want, the deadline, and anything a candidate needs before they can quote."
				class="w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
			></textarea>
		</label>

		<label class="block">
			<span class="mb-1.5 block text-sm font-medium">Arrangement</span>
			<Select bind:value={type} options={types} class="w-full" />
		</label>

		<Field
			label="Budget"
			bind:value={budget}
			inputmode="decimal"
			placeholder="Leave blank to ask"
		/>
		<p class="-mt-2 text-xs text-muted">
			{budgetCents === undefined || !Number.isFinite(budgetCents)
				? 'In rupiah. Blank shows as “Ask”, which is honest when nobody has scoped it yet.'
				: `Candidates will see ${money(budgetCents, 'IDR')}.`}
		</p>

		<label class="block">
			<span class="mb-1.5 block text-sm font-medium">How hiring will go</span>
			<textarea
				bind:value={hiringFlow}
				rows="4"
				maxlength="2000"
				placeholder="The steps a candidate should expect — a portfolio look, a call, a paid test."
				class="w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
			></textarea>
			<span class="mt-1 block text-xs text-muted">
				Optional, and the thing candidates ask about most.
			</span>
		</label>

		<div class="flex gap-2">
			<Button type="submit" disabled={!valid || busy}>{busy ? 'Posting…' : 'Post work'}</Button>
			<Button variant="ghost" href="/realms/{data.realm.slug}">Cancel</Button>
		</div>
	</form>
</Card>
