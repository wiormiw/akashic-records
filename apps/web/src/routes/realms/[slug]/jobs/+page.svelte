<script lang="ts">
	import { SITE_NAME } from '#lib/config.ts';
	import { staggerChildren } from '#lib/motion.ts';
	import Button from '#lib/ui/Button.svelte';
	import Empty from '#lib/ui/Empty.svelte';
	import JobCard from '#lib/ui/JobCard.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isMember = $derived(data.standing.role !== null);
	const canPost = $derived(data.standing.permissions.includes('realm.post_job'));

	// Open work first: a board whose top row is filled jobs reads as a dead board.
	const sorted = $derived(
		[...data.jobs].sort((a, b) => (a.status === 0 ? 0 : 1) - (b.status === 0 ? 0 : 1)),
	);
	const open = $derived(data.jobs.filter((job) => job.status === 0).length);
</script>

<svelte:head>
	<title>Work · {data.realm.name} · {SITE_NAME}</title>
</svelte:head>

<Button variant="ghost" size="sm" href="/realms/{data.realm.slug}" class="-ml-3">
	← {data.realm.name}
</Button>

<div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
	<h1 class="text-2xl font-semibold tracking-tight">Work</h1>
	<span class="text-sm text-muted">{open} open</span>
	{#if canPost}
		<Button variant="outline" size="sm" href="/realms/{data.realm.slug}/jobs/new" class="ml-auto">
			Post work
		</Button>
	{/if}
</div>

{#if sorted.length === 0}
	<div class="mt-6">
		<Empty
			title="Nothing open right now"
			action={canPost ? `/realms/${data.realm.slug}/jobs/new` : undefined}
			actionLabel="Post the first brief"
		>
			Commissions, freelance, anything you would pay somebody here to do.
		</Empty>
	</div>
{:else}
	<ul use:staggerChildren={{ each: 0.02 }} class="mt-6 flex flex-col gap-2">
		{#each sorted as job (job.id)}
			<li>
				<JobCard {job} href={isMember ? `/realms/${data.realm.slug}/jobs/${job.id}` : undefined} />
			</li>
		{/each}
	</ul>
{/if}
