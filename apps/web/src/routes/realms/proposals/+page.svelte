<script lang="ts">
	import { ProposalStatus } from '@akashic/lib/enums';
	import { PROPOSAL_STATUS_LABEL } from '$lib/api/proposals';
	import { MODULE_LABELS } from '$lib/api/realms';
	import { SITE_NAME } from '$lib/config';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Empty from '$lib/ui/Empty.svelte';
	import Sigil from '$lib/ui/Sigil.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	const waiting = $derived(
		data.proposals.some((proposal) => proposal.status === ProposalStatus.pending),
	);
</script>

<svelte:head>
	<title>Your proposals · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/realms" class="-ml-3">← All realms</Button>

<header class="mt-4 flex flex-wrap items-start justify-between gap-3">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Your proposals</h1>
		<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
			Realms you have asked to found, and what came of each. One can be waiting at a time.
		</p>
	</div>

	{#if !waiting}
		<Button href="/realms/new">Propose a realm</Button>
	{/if}
</header>

{#if data.proposals.length === 0}
	<div class="mt-8">
		<Empty title="You have not proposed one" action="/realms/new" actionLabel="Propose a realm">
			A realm is a community with its own members, moderators and modules. Proposing one costs a few
			sentences about who it is for.
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

								{#if proposal.status === ProposalStatus.approved}
									<Badge variant="primary">{PROPOSAL_STATUS_LABEL[proposal.status]}</Badge>
								{:else if proposal.status === ProposalStatus.rejected}
									<Badge variant="accent">{PROPOSAL_STATUS_LABEL[proposal.status]}</Badge>
								{:else}
									<Badge variant="outline">{PROPOSAL_STATUS_LABEL[proposal.status]}</Badge>
								{/if}
							</div>

							<p class="mt-0.5 font-mono text-xs text-muted">/realms/{proposal.slug}</p>

							{#if proposal.modules.length > 0}
								<div class="mt-2 flex flex-wrap gap-1.5">
									{#each proposal.modules as module (module)}
										<Badge variant="neutral">{MODULE_LABELS[module] ?? 'Module'}</Badge>
									{/each}
								</div>
							{/if}

							<blockquote
								class="mt-3 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted"
							>
								{proposal.rationale}
							</blockquote>

							<p class="mt-2 text-xs text-muted">sent {when(proposal.createdAt)}</p>
						</div>
					</div>

					{#if proposal.status === ProposalStatus.approved}
						<Alert variant="success" class="mt-4">
							Approved{proposal.decidedAt ? ` on ${when(proposal.decidedAt)}` : ''}. You are its
							first admin.
							<a href="/realms/{proposal.slug}" class="ml-1 underline underline-offset-4">
								Open it
							</a>.
						</Alert>
					{:else if proposal.status === ProposalStatus.rejected}
						<!-- The note is the whole point of showing a refusal rather than a status. It is also
						     the only way somebody learns what a proposal that would succeed looks like. -->
						<Alert variant="warning" class="mt-4">
							{proposal.decisionNote ?? 'No reason was recorded.'}
						</Alert>
						<p class="mt-2 text-xs text-muted">
							You can propose again with a different name or a clearer case.
						</p>
					{:else}
						<p class="mt-4 text-sm text-muted">
							Waiting for an administrator to read it. You will see their answer here, including a
							reason if it is refused.
						</p>
					{/if}
				</Card>
			</li>
		{/each}
	</ul>
{/if}
