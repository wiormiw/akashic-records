<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { decideReview } from '$lib/api/realms';
	import { SITE_NAME } from '$lib/config';
	import { staggerChildren } from '$lib/motion';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let busy = $state('');
	let error = $state('');

	/** Records a decision, which also teaches the realm when the posting is kept. */
	async function decide(entryId: string, kept: boolean): Promise<void> {
		busy = entryId;
		error = '';

		try {
			await decideReview(data.realm.slug, entryId, kept);
			await invalidateAll();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not record that.';
		} finally {
			busy = '';
		}
	}
</script>

<svelte:head>
	<title>Review · {data.realm.name} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{data.realm.slug}" class="-ml-3">
	← {data.realm.name}
</Button>

<h1 class="mt-4 text-2xl font-semibold tracking-tight">Waiting on you</h1>
<p class="mt-1 max-w-2xl text-sm text-muted">
	Postings the automated check could not call. Keeping one teaches {data.realm.name} what it is — the
	next posting like it will not come here.
</p>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}

{#if data.waiting.length === 0}
	<Card class="mt-6 p-8 text-center">
		<p class="text-muted">Nothing waiting. Everything posted lately was clear enough to call.</p>
	</Card>
{:else}
	<ul use:staggerChildren={{ each: 0.03 }} class="mt-6 flex flex-col gap-3">
		{#each data.waiting as entry (entry.id)}
			<li>
				<Card class="p-4">
					<div class="flex flex-wrap items-center gap-2">
						<Badge variant="outline">{entry.kind === 'jobs' ? 'Job' : 'Listing'}</Badge>
						<a
							href="/realms/{data.realm.slug}/{entry.kind}/{entry.subjectId}"
							class="font-medium hover:text-primary"
						>
							{entry.posting?.title ?? 'Removed since it was queued'}
						</a>
						<span class="ml-auto font-mono text-xs text-muted">
							{entry.distance.toFixed(3)} away
						</span>
					</div>

					{#if entry.posting}
						<p class="mt-2 line-clamp-3 text-sm whitespace-pre-line text-muted">
							{entry.posting.description}
						</p>
					{/if}

					<div class="mt-3 flex gap-2">
						<Button size="sm" disabled={busy !== ''} onclick={() => decide(entry.id, true)}>
							{busy === entry.id ? 'Working…' : 'It belongs here'}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={busy !== ''}
							onclick={() => decide(entry.id, false)}
						>
							Take it down
						</Button>
					</div>
				</Card>
			</li>
		{/each}
	</ul>
{/if}
