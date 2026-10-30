<script lang="ts">
	import { onMount } from 'svelte';
	import { ensurePublished, listRooms, type RoomSummary } from '#lib/api/rooms.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import { revealOnView, staggerChildren } from '#lib/motion.ts';
	import Alert from '#lib/ui/Alert.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Empty from '#lib/ui/Empty.svelte';

	let rooms = $state<RoomSummary[]>([]);
	let loading = $state(true);
	let error = $state('');

	onMount(async () => {
		try {
			// Publishing before listing: a reader whose keys are not up there cannot be written to,
			// and the inbox is the first place they will notice.
			await ensurePublished();
			rooms = await listRooms();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not load your conversations.';
		} finally {
			loading = false;
		}
	});

	/**
	 * Formats when a conversation was last active.
	 *
	 * @param iso ISO-8601 timestamp, or null for a room nobody has spoken in.
	 * @returns A short date, or a nudge.
	 */
	const when = (iso: string | null): string => {
		if (!iso) return '';

		const at = new Date(iso);
		const today = new Date().toDateString() === at.toDateString();

		// Today's conversations are the ones being had, so they get a time; older ones get a date,
		// which is what tells them apart at a glance.
		return today
			? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
			: at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	};
</script>

<svelte:head>
	<title>Messages · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div use:revealOnView={{ y: 16 }}>
	<h1 class="text-2xl font-semibold tracking-tight">Messages</h1>
	<p class="mt-1 max-w-2xl text-sm text-muted">
		Private, and encrypted on your device. This server relays what it cannot read — it knows a
		conversation happened, not what was said. Safety codes live in each conversation's details.
	</p>
</div>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}

{#if loading}
	<ul class="mt-6 flex flex-col gap-2">
		{#each { length: 3 } as _, index (index)}
			<li class="h-16 animate-pulse rounded-app border border-border bg-surface-2/60"></li>
		{/each}
	</ul>
{:else if rooms.length === 0}
	<div class="mt-6">
		<Empty title="No conversations yet" action="/realms" actionLabel="Find a realm">
			They start from a piece of work or something for sale — open one and message whoever posted
			it.
		</Empty>
	</div>
{:else}
	<ul use:staggerChildren={{ each: 0.03 }} class="mt-6 flex flex-col gap-1.5">
		{#each rooms as room (room.id)}
			<li>
				<a
					href="/rooms/{room.id}"
					class="flex items-center gap-3 rounded-app border border-border bg-surface px-3 py-2.5 transition-[border-color] duration-150 hover:border-primary/60 focus-visible:border-primary/60"
				>
					<Avatar name={room.otherName} id={room.otherId} />

					<div class="min-w-0 flex-1">
						<p class="truncate font-medium">{room.otherName}</p>
						<p class="text-xs text-muted">
							About {room.subjectKind === 0 ? 'a job' : 'a listing'}
						</p>
					</div>

					{#if room.lastMessageAt}
						<span class="shrink-0 text-xs text-muted">{when(room.lastMessageAt)}</span>
					{:else}
						<Badge variant="outline">new</Badge>
					{/if}
				</a>
			</li>
		{/each}
	</ul>
{/if}
