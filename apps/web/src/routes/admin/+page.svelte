<script lang="ts">
	import { countUp, revealOnView, staggerChildren } from '#lib/motion.ts';
	import Card from '#lib/ui/Card.svelte';
	import type { LayoutData } from './$types';

	let { data }: { data: LayoutData } = $props();

	/**
	 * The figures, in the order they matter.
	 *
	 * Things waiting for a person first. A dashboard that opens with a total account count is a
	 * dashboard nobody acts on — the number is true, and there is nothing to do about it.
	 */
	const waiting = $derived([
		{
			label: 'reports waiting',
			value: data.overview.openReports,
			href: '/admin/reports',
			hint: 'Nobody has read these yet.',
		},
		{
			label: 'realms with no admin',
			value: data.overview.orphaned,
			href: '/admin/realms',
			hint: 'Frozen until somebody is given the keys.',
		},
	]);

	const standing = $derived([
		{ label: 'realms', value: data.overview.realms, href: '/admin/realms' },
		{ label: 'archived', value: data.overview.archived, href: '/admin/realms' },
		{ label: 'accounts', value: data.overview.members, href: null },
		{ label: 'audit entries', value: data.overview.auditEntries, href: '/admin/audit' },
	]);
</script>

<svelte:head>
	<title>Control panel</title>
</svelte:head>

<header use:revealOnView={{ y: 16 }}>
	<h1 class="text-2xl font-semibold tracking-tight">Control panel</h1>
	<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
		Governance of the whole deployment: communities, the report queue, accounts, and the record of
		who changed what.
	</p>
</header>

<!-- Two blocks, because they are two different kinds of number. The first is a to-do list; the
     second is the shape of the deployment. Rendering them alike made the urgent ones invisible. -->
<section class="mt-8" use:staggerChildren={{ each: 0.06 }}>
	<div class="grid gap-3 sm:grid-cols-2">
		{#each waiting as figure (figure.label)}
			<a href={figure.href} class="block">
				<Card class="p-5 transition-colors hover:border-primary">
					<p class="text-3xl font-semibold tabular-nums" class:text-accent={figure.value > 0}>
						<span use:countUp={{ value: figure.value }}>{figure.value}</span>
					</p>
					<p class="mt-1 text-sm font-medium">{figure.label}</p>
					<p class="mt-0.5 text-xs text-muted">
						{figure.value > 0 ? figure.hint : 'Nothing waiting.'}
					</p>
				</Card>
			</a>
		{/each}
	</div>
</section>

<section class="mt-6">
	<dl class="flex flex-wrap gap-x-10 gap-y-4" use:staggerChildren={{ each: 0.05 }}>
		{#each standing as figure (figure.label)}
			<div>
				<dd class="text-2xl font-semibold tabular-nums">
					<span use:countUp={{ value: figure.value }}>{figure.value}</span>
				</dd>
				<dt class="text-xs tracking-wide text-muted uppercase">
					{#if figure.href}
						<a href={figure.href} class="underline-offset-4 hover:underline">{figure.label}</a>
					{:else}
						{figure.label}
					{/if}
				</dt>
			</div>
		{/each}
	</dl>
</section>
