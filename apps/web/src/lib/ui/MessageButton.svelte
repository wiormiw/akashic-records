<script lang="ts">
	import { goto } from '$app/navigation';
	import { openRoom } from '$lib/api/rooms';
	import Button from '$lib/ui/Button.svelte';

	/**
	 * Starts the private conversation about one posting.
	 *
	 * Hidden from the person who posted it — messaging yourself is not a thing, and the API would
	 * refuse anyway.
	 */
	let {
		realmSlug,
		subjectKind,
		subjectId,
		ownerId,
		ownerName,
		viewerId,
	}: {
		realmSlug: string;
		subjectKind: number;
		subjectId: string;
		ownerId: string;
		ownerName: string;
		viewerId: string | undefined;
	} = $props();

	let busy = $state(false);
	let error = $state('');

	/** Opens or reuses the room, then goes there. */
	async function start(): Promise<void> {
		busy = true;
		error = '';

		try {
			const { id } = await openRoom(realmSlug, subjectKind, subjectId, ownerId);
			await goto(`/rooms/${id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not start that conversation.';
			busy = false;
		}
	}
</script>

{#if viewerId && viewerId !== ownerId}
	<Button onclick={start} disabled={busy} class="w-full">
		{busy ? 'Opening…' : `Message ${ownerName}`}
	</Button>

	<p class="text-xs text-muted">
		Private and encrypted on your device. Neither this site nor a moderator can read it unless one
		of you reports a message.
	</p>

	{#if error}
		<p class="text-xs text-accent">{error}</p>
	{/if}
{/if}
