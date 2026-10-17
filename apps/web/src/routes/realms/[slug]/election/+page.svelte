<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import {
		RECALL_KIND,
		proposeRecall,
		removeSeat,
		upvote,
		voteOnRecall,
		withdrawUpvote,
		type Standing,
	} from '$lib/api/governance';
	import { SITE_NAME } from '$lib/config';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Input from '$lib/ui/Input.svelte';
	import Select from '$lib/ui/Select.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let error = $state('');
	let notice = $state('');
	let working = $state('');

	/** Which member's recall form is open. */
	let recalling = $state('');
	let reason = $state('');
	let kind = $state(String(RECALL_KIND.members));

	const slug = $derived(data.realm.slug);
	const canAdminister = $derived(data.standing.permissions.includes('realm.administer'));
	const isModerator = $derived(data.standing.role !== null && data.standing.role >= 2);

	/** Who holds a seat, and who is next in line. */
	const seated = $derived(data.standings.members.filter((m) => m.seated));
	const contenders = $derived(data.standings.members.filter((m) => !m.seated && m.role < 3));
	const admins = $derived(data.standings.members.filter((m) => m.role === 3));

	function clear(): void {
		error = '';
		notice = '';
	}

	/** Runs one action, reloading so every count on the page agrees afterwards. */
	async function act(key: string, work: () => Promise<unknown>, said: string): Promise<void> {
		clear();
		working = key;

		try {
			await work();
			await invalidateAll();
			notice = said;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = '';
		}
	}

	const recallLabels = [
		{ value: String(RECALL_KIND.members), label: 'The members decide — simple majority' },
		{ value: String(RECALL_KIND.moderators), label: 'The other moderators decide — 80% agree' },
	];

	const when = (iso: string): string =>
		new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
</script>

<svelte:head>
	<title>Election · {data.realm.name} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{slug}" class="-ml-3">← {data.realm.name}</Button>

<header class="mt-4">
	<h1 class="text-2xl font-semibold tracking-tight">Moderator seats</h1>
	<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
		This realm has <strong>{data.standings.seats}</strong>
		{data.standings.seats === 1 ? 'seat' : 'seats'}, one for every twenty-five members. The most
		upvoted members hold them, and a seat needs at least
		<strong>{data.standings.minimum}</strong> upvotes to be worth holding at all. Upvote anybody you would
		trust to moderate; take it back whenever you change your mind.
	</p>
</header>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}
{#if notice}
	<Alert variant="success" class="mt-4">{notice}</Alert>
{/if}

{#if data.recalls.length > 0}
	<section class="mt-8">
		<h2 class="text-lg font-semibold tracking-tight">Open recalls</h2>
		<p class="mt-1 text-sm text-muted">
			A move to take somebody's seat away. A carried recall clears the upvotes behind it, so they
			re-enter the standings from zero.
		</p>

		<ul class="mt-3 flex flex-col gap-2">
			{#each data.recalls as recall (recall.id)}
				<li>
					<Card class="p-4">
						<div class="flex flex-wrap items-start gap-3">
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{recall.subject?.name ?? 'A moderator'}</span>
									<Badge variant="accent">
										{recall.kind === RECALL_KIND.members ? 'members vote' : 'moderators vote'}
									</Badge>
									<span class="text-sm text-muted tabular-nums">
										{recall.agrees} for · {recall.refusals} against
									</span>
								</div>

								<blockquote
									class="mt-2 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted"
								>
									{recall.reason}
								</blockquote>

								<p class="mt-1 text-xs text-muted">
									started by {recall.proposedBy?.name ?? 'someone'} · {when(recall.createdAt)}
								</p>
							</div>

							<!-- The API decides whether this caller is in the electorate; the page offers the
							     buttons and lets it say no, rather than duplicating the rule and disagreeing. -->
							<div class="flex shrink-0 gap-1">
								<Button
									variant="outline"
									size="sm"
									disabled={working === recall.id}
									onclick={() =>
										act(recall.id, () => voteOnRecall(slug, recall.id, true), 'Vote recorded.')}
								>
									Remove them
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={working === recall.id}
									onclick={() =>
										act(recall.id, () => voteOnRecall(slug, recall.id, false), 'Vote recorded.')}
								>
									Keep them
								</Button>
							</div>
						</div>
					</Card>
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#snippet row(member: Standing, rank: number | null)}
	<Card class="p-4">
		<div class="flex flex-wrap items-center gap-3">
			{#if rank !== null}
				<span class="w-6 shrink-0 text-sm text-muted tabular-nums">{rank}</span>
			{/if}

			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-medium">{member.name}</span>
					{#if member.role === 3}
						<Badge variant="primary">admin</Badge>
					{:else if member.seated}
						<Badge variant="primary">seated</Badge>
					{/if}
				</div>
				<p class="mt-0.5 text-xs text-muted">joined {when(member.joinedAt)}</p>
			</div>

			<span class="shrink-0 text-sm tabular-nums">
				<strong>{member.upvotes}</strong>
				<span class="text-muted">{member.upvotes === 1 ? 'upvote' : 'upvotes'}</span>
			</span>

			{#if member.role !== 3}
				<div class="flex shrink-0 flex-wrap gap-1">
					<Button
						variant="ghost"
						size="sm"
						disabled={working === member.userId}
						onclick={() =>
							act(member.userId, () => upvote(slug, member.userId), 'Upvote recorded.')}
					>
						Upvote
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={working === member.userId}
						onclick={() =>
							act(member.userId, () => withdrawUpvote(slug, member.userId), 'Upvote withdrawn.')}
					>
						Take back
					</Button>

					{#if member.seated}
						<Button
							variant="ghost"
							size="sm"
							onclick={() => {
								clear();
								recalling = recalling === member.userId ? '' : member.userId;
								reason = '';
							}}
						>
							{recalling === member.userId ? 'Cancel' : 'Recall'}
						</Button>
					{/if}
				</div>
			{/if}
		</div>

		{#if recalling === member.userId}
			<form
				class="mt-4 flex flex-col gap-3 border-t border-border pt-4"
				onsubmit={(event) => {
					event.preventDefault();
					void act(
						member.userId,
						() => proposeRecall(slug, member.userId, Number(kind), reason.trim()),
						'Recall opened.',
					).then(() => (recalling = ''));
				}}
			>
				<label>
					<span class="mb-1 block text-sm">Why should they lose the seat?</span>
					<Input bind:value={reason} required placeholder="Whoever votes reads this." />
				</label>

				<div class="flex flex-wrap items-end gap-3">
					<label class="min-w-0 flex-1">
						<span class="mb-1 block text-sm">Who decides</span>
						<Select bind:value={kind} options={recallLabels} />
					</label>

					<Button disabled={working === member.userId || reason.trim().length < 8}>
						Open the recall
					</Button>
				</div>

				{#if canAdminister}
					<!-- The third route the design asked for: no vote, no delay, and a reason recorded in
					     the audit trail because nothing else will say why it happened. -->
					<div class="border-t border-border pt-3">
						<Button
							variant="outline"
							size="sm"
							type="button"
							disabled={working === member.userId || reason.trim().length < 8}
							onclick={() =>
								act(
									member.userId,
									() => removeSeat(slug, member.userId, reason.trim()),
									'Seat taken back.',
								).then(() => (recalling = ''))}
						>
							Or take the seat back now, as an admin
						</Button>
						<p class="mt-1 text-xs text-muted">
							No vote. Use it when a moderator is doing damage and a vote would take days.
						</p>
					</div>
				{/if}
			</form>
		{/if}
	</Card>
{/snippet}

<section class="mt-8">
	<h2 class="text-lg font-semibold tracking-tight">
		Holding seats
		<span class="text-sm font-normal text-muted">
			{seated.length} of {data.standings.seats}
		</span>
	</h2>

	{#if seated.length === 0}
		<p class="mt-2 text-sm text-muted">
			Nobody yet. The first member to reach {data.standings.minimum} upvotes takes a seat.
		</p>
	{:else}
		<ul class="mt-3 flex flex-col gap-2">
			{#each seated as member, index (member.userId)}
				<li>{@render row(member, index + 1)}</li>
			{/each}
		</ul>
	{/if}
</section>

{#if contenders.length > 0}
	<section class="mt-8">
		<h2 class="text-lg font-semibold tracking-tight">In the running</h2>
		<p class="mt-1 text-sm text-muted">
			Everybody else, most upvoted first. Passing somebody seated takes their seat.
		</p>

		<ul class="mt-3 flex flex-col gap-2">
			{#each contenders as member (member.userId)}
				<li>{@render row(member, null)}</li>
			{/each}
		</ul>
	</section>
{/if}

{#if admins.length > 0}
	<section class="mt-8">
		<h2 class="text-lg font-semibold tracking-tight">Admins</h2>
		<p class="mt-1 text-sm text-muted">
			They moderate by running the realm, hold no elected seat, and cannot be upvoted or recalled.
		</p>

		<ul class="mt-3 flex flex-col gap-2">
			{#each admins as member (member.userId)}
				<li>{@render row(member, null)}</li>
			{/each}
		</ul>
	</section>
{/if}

{#if !isModerator}
	<p class="mt-8 text-xs text-muted">
		Anybody here can upvote and start a members' recall. Voting inside a moderators' recall is for
		seat holders, and the API will say so if you try.
	</p>
{/if}
