<script lang="ts">
	import { JOB_STATUS_LABELS, JOB_TYPE_LABELS, money, type JobDetail } from '$lib/api/realms';
	import { RoomSubject } from '@akashic/lib/enums';
	import { SITE_NAME } from '$lib/config';
	import { revealOnView } from '$lib/motion';
	import Badge from '$lib/ui/Badge.svelte';
	import Breadcrumbs from '$lib/ui/Breadcrumbs.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Interest from '$lib/ui/Interest.svelte';
	import MessageButton from '$lib/ui/MessageButton.svelte';
	import Takedown from '$lib/ui/Takedown.svelte';
	import Thread from '$lib/ui/Thread.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const job = $derived(data.posting as JobDetail);
	// Closed and filled are different reasons for the same fact: nobody else can apply.
	const closed = $derived(job.status !== 0);
	const canModerate = $derived(data.standing.permissions.includes('realm.moderate'));
	const posted = $derived(
		new Date(job.createdAt).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
		}),
	);
</script>

<svelte:head>
	<title>{job.title} · {data.realm.name}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Breadcrumbs
	trail={[
		{ href: '/realms', label: 'Realms' },
		{ href: `/realms/${data.realm.slug}`, label: data.realm.name },
		{ href: `/realms/${data.realm.slug}/jobs`, label: 'Work' },
		{ label: job.title },
	]}
/>

<article
	class="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
	use:revealOnView={{ y: 16 }}
>
	<div class="min-w-0">
		<div class="flex flex-wrap items-center gap-2">
			<h1 class="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{job.title}</h1>
			{#if closed}
				<Badge variant="accent">{JOB_STATUS_LABELS[job.status] ?? 'Closed'}</Badge>
			{/if}
		</div>

		<p class="mt-1 text-sm text-muted">
			Posted by <span class="text-text">{job.authorName}</span> · {posted}
		</p>

		<p class="mt-5 leading-relaxed whitespace-pre-line">{job.description}</p>

		{#if job.hiringFlow}
			<!-- The thing candidates ask about most, in the poster's own words. -->
			<Card class="mt-6 p-4">
				<h2 class="text-sm font-semibold">How hiring will go</h2>
				<p class="mt-2 text-sm leading-relaxed whitespace-pre-line">{job.hiringFlow}</p>
			</Card>
		{/if}
	</div>

	<aside class="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20 lg:self-start">
		<Card class="p-4">
			<p class="text-2xl font-semibold tabular-nums">
				{job.budgetCents === null ? 'Ask' : money(job.budgetCents, job.currency)}
			</p>
			<dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
				<dt class="text-muted">Type</dt>
				<dd>{JOB_TYPE_LABELS[job.type] ?? 'Work'}</dd>
				<dt class="text-muted">Status</dt>
				<dd>{closed ? (JOB_STATUS_LABELS[job.status] ?? 'Closed') : 'Open'}</dd>
			</dl>

			<div class="mt-4">
				<MessageButton
					realmSlug={data.realm.slug}
					subjectKind={RoomSubject.job}
					subjectId={job.id}
					ownerId={job.authorId}
					ownerName={job.authorName}
					viewerId={data.user?.id}
				/>
			</div>
		</Card>

		<Interest
			slug={data.realm.slug}
			kind="jobs"
			id={job.id}
			ownerId={job.authorId}
			viewerId={data.user?.id}
			interested={job.viewerInterested}
			settled={closed}
			verb="Hire"
		/>

		<Takedown
			slug={data.realm.slug}
			kind="jobs"
			id={job.id}
			ownerId={job.authorId}
			viewerId={data.user?.id}
			{canModerate}
			settled={closed}
		/>
	</aside>
</article>

<Thread
	slug={data.realm.slug}
	kind="jobs"
	id={job.id}
	enabled={job.commentsEnabled && !closed}
	initial={data.thread}
	{canModerate}
/>
