<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { approveProposal, rejectProposal, type Proposal } from '$lib/api/proposals';
	import { MODULE_LABELS } from '$lib/api/realms';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Empty from '$lib/ui/Empty.svelte';
	import Input from '$lib/ui/Input.svelte';
	import Sigil from '$lib/ui/Sigil.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let error = $state('');
	let notice = $state('');
	let working = $state('');

	/** Which proposal's refusal form is open, and the note being written into it. */
	let refusing = $state('');
	let note = $state('');

	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	/** How long it has been waiting, because that is what decides what to read first. */
	function waited(iso: string): string {
		const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

		if (days === 0) return 'today';
		if (days === 1) return 'since yesterday';

		return `for ${days} days`;
	}

	function clear(): void {
		error = '';
		notice = '';
	}

	async function approve(proposal: Proposal): Promise<void> {
		clear();
		working = proposal.id;

		try {
			await approveProposal(proposal.id);
			await invalidateAll();
			notice = `${proposal.name} exists, and ${proposal.proposedBy?.name ?? 'the proposer'} is its admin.`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = '';
		}
	}

	async function refuse(proposal: Proposal): Promise<void> {
		clear();
		working = proposal.id;

		try {
			await rejectProposal(proposal.id, note.trim());
			refusing = '';
			note = '';
			await invalidateAll();
			notice = 'Refused, and they can read why.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = '';
		}
	}
</script>

<svelte:head>
	<title>Proposals · Control panel</title>
</svelte:head>

<header>
	<h1 class="text-2xl font-semibold tracking-tight">Proposals</h1>
	<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
		Realms somebody has asked to found, oldest first. The rationale is the part to read: it is what
		the proposer wrote about who the community is for, and the only thing that distinguishes a real
		request from a passing thought.
	</p>
</header>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}
{#if notice}
	<Alert variant="success" class="mt-4">{notice}</Alert>
{/if}

{#if data.proposals.length === 0}
	<div class="mt-6">
		<Empty title="Nothing waiting">
			Every proposal has been decided. New ones appear here as they are sent.
		</Empty>
	</div>
{:else}
	<ul class="mt-6 flex flex-col gap-3">
		{#each data.proposals as proposal (proposal.id)}
			<li>
				<Card class="p-5">
					<div class="flex flex-wrap items-start gap-4">
						<Sigil slug={proposal.slug} size={44} class="mt-0.5 shrink-0" />

						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-lg font-medium">{proposal.name}</span>
								<Badge variant="outline">waiting {waited(proposal.createdAt)}</Badge>
							</div>

							<p class="mt-0.5 font-mono text-xs text-muted">/realms/{proposal.slug}</p>

							<p class="mt-1 text-sm text-muted">
								asked by {proposal.proposedBy?.name ?? 'a deleted account'}
								{#if proposal.proposedBy}
									<span class="text-xs">&lt;{proposal.proposedBy.email}&gt;</span>
								{/if}
								· {when(proposal.createdAt)}
							</p>

							{#if proposal.modules.length > 0}
								<div class="mt-2 flex flex-wrap gap-1.5">
									{#each proposal.modules as module (module)}
										<Badge variant="neutral">{MODULE_LABELS[module] ?? 'Module'}</Badge>
									{/each}
								</div>
							{/if}
						</div>
					</div>

					<!-- The rationale gets the room, because it is the thing being judged. Everything above
					     it is metadata that helps only after the decision is already leaning one way. -->
					<blockquote class="mt-4 border-l-2 border-primary pl-4 leading-relaxed">
						{proposal.rationale}
					</blockquote>

					{#if proposal.description}
						<p class="mt-3 text-sm text-muted">
							<span class="text-xs uppercase">card text</span>
							· {proposal.description}
						</p>
					{/if}

					<div class="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
						<Button disabled={working === proposal.id} onclick={() => void approve(proposal)}>
							{working === proposal.id ? 'Working…' : 'Approve and found it'}
						</Button>

						<Button
							variant="ghost"
							onclick={() => {
								clear();
								refusing = refusing === proposal.id ? '' : proposal.id;
								note = '';
							}}
						>
							{refusing === proposal.id ? 'Cancel' : 'Refuse'}
						</Button>
					</div>

					{#if refusing === proposal.id}
						<form
							class="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4"
							onsubmit={(event) => {
								event.preventDefault();
								void refuse(proposal);
							}}
						>
							<label class="min-w-0 flex-1">
								<span class="mb-1 block text-sm">Why not?</span>
								<Input bind:value={note} required placeholder="Too close to an existing realm." />
								<span class="mt-1 block text-xs text-muted">
									<strong>{proposal.proposedBy?.name ?? 'They'} will read this.</strong> It is also the
									only way somebody learns what a proposal that would succeed looks like.
								</span>
							</label>

							<Button disabled={working === proposal.id || note.trim().length < 4}>
								Send the refusal
							</Button>
						</form>
					{/if}
				</Card>
			</li>
		{/each}
	</ul>
{/if}
