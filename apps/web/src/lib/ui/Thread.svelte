<script lang="ts">
	import { addComment, listComments, removeComment, type Comment } from '#lib/api/realms.ts';
	import { staggerChildren } from '#lib/motion.ts';
	import Alert from './Alert.svelte';
	import Button from './Button.svelte';
	import Card from './Card.svelte';

	/**
	 * The discussion under an event, a job or a listing.
	 *
	 * One component for all three, because the API is one thread implementation — a comment on a
	 * listing and a comment on an event differ only in what they hang off.
	 *
	 * Removed comments keep their place as tombstones rather than vanishing: a thread that
	 * silently loses a message reads as a bug to everyone who saw it happen.
	 */
	let {
		slug,
		kind,
		id,
		enabled,
		initial = [],
		canModerate = false,
	}: {
		slug: string;
		kind: 'events' | 'jobs' | 'listings';
		id: string;
		/** False when the author closed the thread. The existing discussion still shows. */
		enabled: boolean;
		initial?: Comment[];
		/** Whether the reader may remove somebody else's comment. */
		canModerate?: boolean;
	} = $props();

	// Seeded from the server render, then owned locally: posting re-reads the thread rather than
	// guessing where the server would have put the new comment.
	let thread = $state<Comment[]>([]);
	$effect(() => {
		thread = initial;
	});
	let draft = $state('');
	let posting = $state(false);
	let error = $state('');

	/** Sends the draft, then re-reads the thread so ordering matches the server's. */
	async function send(event: SubmitEvent): Promise<void> {
		event.preventDefault();

		const body = draft.trim();
		if (body.length === 0) return;

		error = '';
		posting = true;

		try {
			await addComment(slug, kind, id, body);
			draft = '';
			thread = await listComments(slug, kind, id);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not post that.';
		} finally {
			posting = false;
		}
	}

	/** Removes one comment, leaving its tombstone. */
	async function remove(comment: Comment): Promise<void> {
		error = '';

		try {
			await removeComment(slug, comment.id);
			thread = await listComments(slug, kind, id);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not remove that.';
		}
	}

	/**
	 * Formats a comment's timestamp.
	 *
	 * @param iso ISO-8601 timestamp.
	 * @returns A short date and time.
	 */
	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, {
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
		});
</script>

<section class="mt-8">
	<div class="flex flex-wrap items-baseline gap-2">
		<h2 class="text-lg font-semibold tracking-tight">Discussion</h2>
		<span class="text-sm text-muted"
			>{thread.length} {thread.length === 1 ? 'comment' : 'comments'}</span
		>
	</div>

	{#if thread.length > 0}
		<ul use:staggerChildren={{ each: 0.02 }} class="mt-4 flex flex-col gap-2">
			{#each thread as comment (comment.id)}
				<li>
					<Card class="p-4">
						<div class="flex items-baseline gap-2">
							<span class="text-sm font-medium">{comment.authorName}</span>
							<span class="ml-auto font-mono text-xs text-muted">{when(comment.createdAt)}</span>
						</div>

						{#if comment.removed}
							<p class="mt-1 text-sm text-muted italic">Removed by a moderator.</p>
						{:else}
							<p class="mt-1 text-sm leading-relaxed whitespace-pre-line">{comment.body}</p>

							{#if canModerate}
								<button
									type="button"
									onclick={() => remove(comment)}
									class="mt-2 text-xs text-muted underline underline-offset-2 hover:text-text"
								>
									Remove
								</button>
							{/if}
						{/if}
					</Card>
				</li>
			{/each}
		</ul>
	{/if}

	{#if enabled}
		<form class="mt-4 flex flex-col gap-2" onsubmit={send}>
			<label class="block">
				<span class="sr-only">Add a comment</span>
				<textarea
					bind:value={draft}
					rows="3"
					maxlength="2000"
					placeholder="Ask a question, or say you are interested."
					class="w-full rounded-app border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
				></textarea>
			</label>

			{#if error}
				<Alert variant="warning" assertive>{error}</Alert>
			{/if}

			<div class="flex justify-end">
				<Button type="submit" size="sm" disabled={posting || draft.trim().length === 0}>
					{posting ? 'Posting…' : 'Post comment'}
				</Button>
			</div>
		</form>
	{:else}
		<Alert variant="info" class="mt-4">
			Comments are closed on this one. What is already here stays.
		</Alert>
	{/if}
</section>
