<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { reviewReport } from '$lib/api/platform';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Empty from '$lib/ui/Empty.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let error = $state('');
	let notice = $state('');
	let working = $state('');

	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	/** Marks a report as read, then reloads so the queue and the sidebar badge agree. */
	async function markRead(id: string): Promise<void> {
		error = '';
		notice = '';
		working = id;

		try {
			await reviewReport(id);
			await invalidateAll();
			notice = 'Marked as reviewed.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = '';
		}
	}
</script>

<svelte:head>
	<title>Reports · Control panel</title>
</svelte:head>

<header>
	<h1 class="text-2xl font-semibold tracking-tight">Reports</h1>
	<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
		Reports about direct messages. A room is between two accounts and belongs to no realm, so no
		realm moderator has standing over one — this queue is the only place they can be read.
	</p>
</header>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}
{#if notice}
	<Alert variant="success" class="mt-4">{notice}</Alert>
{/if}

{#if data.reports.length === 0}
	<div class="mt-6">
		<Empty title="No reports, ever">
			Nobody has reported a direct message on this deployment. The queue exists so that the first
			person who does is not reporting into nothing.
		</Empty>
	</div>
{:else}
	<ul class="mt-6 flex flex-col gap-2">
		{#each data.reports as report (report.id)}
			<li>
				<Card class="p-4 {report.reviewedAt ? 'opacity-60' : ''}">
					<div class="flex flex-wrap items-start gap-3">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<Badge variant={report.reviewedAt ? 'neutral' : 'accent'}>{report.reason}</Badge>
								{#if report.senderMatches === false}
									<!-- The one check the server can make on an end-to-end encrypted room: the
									     envelope. It catches a report naming the wrong person. -->
									<Badge variant="outline">the accused did not send it</Badge>
								{/if}
								{#if report.reviewedAt}
									<Badge variant="outline">reviewed {when(report.reviewedAt)}</Badge>
								{/if}
							</div>

							<p class="mt-2 text-sm">
								<strong>{report.reporter?.name ?? 'Someone'}</strong>
								reported
								<strong>{report.accused?.name ?? 'someone'}</strong>
								· {when(report.createdAt)}
							</p>

							{#if report.disclosedText}
								<blockquote
									class="mt-2 border-l-2 border-border pl-3 text-sm leading-relaxed text-muted"
								>
									{report.disclosedText}
								</blockquote>
								<p class="mt-1 text-xs text-muted">
									Quoted by the reporter. Rooms are end-to-end encrypted, so the server cannot
									confirm the words — only who sent the message.
								</p>
							{/if}
						</div>

						{#if !report.reviewedAt}
							<Button
								variant="outline"
								size="sm"
								disabled={working === report.id}
								onclick={() => void markRead(report.id)}
							>
								{working === report.id ? 'Marking…' : 'Mark reviewed'}
							</Button>
						{/if}
					</div>
				</Card>
			</li>
		{/each}
	</ul>
{/if}
