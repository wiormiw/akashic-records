<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { setPostingStatus } from '#lib/api/realms.ts';
	import Alert from './Alert.svelte';
	import Button from './Button.svelte';

	/**
	 * Closing a posting down.
	 *
	 * The poster shuts their own when it is no longer wanted; a moderator shuts anyone's. Both go
	 * through the same endpoint, which decides for itself — this only renders the control for
	 * somebody the API will say yes to.
	 */
	let {
		slug,
		kind,
		id,
		ownerId,
		viewerId,
		canModerate,
		settled,
	}: {
		slug: string;
		kind: 'jobs' | 'listings';
		id: string;
		ownerId: string;
		viewerId: string | undefined;
		canModerate: boolean;
		/** Already filled, sold or closed. Nothing left to take down. */
		settled: boolean;
	} = $props();

	const mine = $derived(viewerId === ownerId);
	// Jobs close; listings are removed. Different words for the same shape of act.
	const status = $derived(kind === 'jobs' ? 1 : 2);

	let busy = $state(false);
	let error = $state('');
	let confirming = $state(false);

	/** Shuts the posting. */
	async function act(): Promise<void> {
		busy = true;
		error = '';

		try {
			await setPostingStatus(slug, kind, id, status);
			await invalidateAll();
			confirming = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not do that.';
		} finally {
			busy = false;
		}
	}
</script>

{#if !settled && (mine || canModerate)}
	{#if error}
		<Alert variant="warning" assertive>{error}</Alert>
	{/if}

	{#if confirming}
		<div class="flex flex-wrap gap-2">
			<Button size="sm" variant="outline" disabled={busy} onclick={act}>
				{busy ? 'Working…' : 'Yes, take it down'}
			</Button>
			<Button size="sm" variant="ghost" onclick={() => (confirming = false)}>Keep it</Button>
		</div>
		<p class="text-xs text-muted">
			It stops taking applicants and stays readable. The discussion under it stays too.
		</p>
	{:else}
		<Button size="sm" variant="ghost" class="-ml-3" onclick={() => (confirming = true)}>
			{mine
				? kind === 'jobs'
					? 'Close this posting'
					: 'Take this listing down'
				: 'Remove as moderator'}
		</Button>
	{/if}
{/if}
