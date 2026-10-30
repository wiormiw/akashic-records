<script lang="ts">
	import { JOB_TYPE_LABELS, money, type JobTeaser } from '#lib/api/realms.ts';
	import Badge from './Badge.svelte';

	/**
	 * One piece of work on offer.
	 *
	 * Budget on the right, aligned and tabular, so a column of them compares at a glance. "Ask" is
	 * shown rather than a blank, because an absent number and a number nobody has decided yet mean
	 * different things to somebody deciding whether to apply.
	 */
	let { job, href = undefined }: { job: JobTeaser; href?: string } = $props();

	const closed = $derived(job.status !== 0);
</script>

<svelte:element
	this={href ? 'a' : 'div'}
	{href}
	class="flex items-center gap-4 rounded-app border border-border bg-surface p-3 transition-[border-color] duration-150 hover:border-primary/60 focus-visible:border-primary/60"
>
	<div class="min-w-0 flex-1">
		<p class="truncate font-medium" class:opacity-60={closed}>{job.title}</p>
		<p class="mt-0.5 text-xs text-muted">{JOB_TYPE_LABELS[job.type] ?? 'Work'}</p>
	</div>

	{#if closed}
		<Badge variant="accent">Closed</Badge>
	{:else}
		<span class="shrink-0 text-sm font-semibold tabular-nums">
			{job.budgetCents === null ? 'Ask' : money(job.budgetCents, job.currency)}
		</span>
	{/if}
</svelte:element>
