<script lang="ts">
	import { MODULE_LABELS } from '$lib/api/realms';
	import { SITE_NAME, SITE_URL } from '$lib/config';
	import { identityOf } from '$lib/realm-identity';
	import { revealOnView, staggerChildren } from '$lib/motion';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Empty from '$lib/ui/Empty.svelte';
	import Sigil from '$lib/ui/Sigil.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Realms · {SITE_NAME}</title>
	<meta
		name="description"
		content="Communities with their own members, roles and rules — each running jobs, events and a marketplace of its own."
	/>
	<link rel="canonical" href="{SITE_URL}/realms" />
</svelte:head>

<div class="flex flex-wrap items-end gap-4" use:revealOnView={{ y: 16 }}>
	<div class="min-w-0 flex-1">
		<h1 class="text-2xl font-semibold tracking-tight">Realms</h1>
		<p class="mt-1 max-w-2xl text-muted">
			Each one is a community with its own members and its own moderators. Listings are open to
			anyone; the detail behind them is for members, which is what keeps a realm a room rather than
			a feed.
		</p>
	</div>

	{#if data.signedIn}
		<Button href="/realms/new" variant="outline">Found a realm</Button>
	{/if}
</div>

{#if data.realms.length === 0}
	<div class="mt-8">
		<Empty
			title="No realms yet"
			action={data.signedIn ? '/realms/new' : '/login?next=/realms/new'}
			actionLabel="Found the first one"
		>
			A realm is a community with its own members, its own moderators, and whichever of jobs, events
			and a marketplace it wants to run.
		</Empty>
	</div>
{:else}
	<ul use:staggerChildren={{ each: 0.04 }} class="mt-8 grid gap-3 sm:grid-cols-2">
		{#each data.realms as realm (realm.id)}
			{@const identity = identityOf(realm.slug)}
			<li>
				<a
					href="/realms/{realm.slug}"
					class="group flex h-full flex-col overflow-hidden rounded-app border border-border bg-surface transition-[border-color,transform] duration-150 hover:border-primary/60 focus-visible:border-primary/60 active:scale-[0.995]"
				>
					<div
						class="flex items-start gap-4 p-5"
						style="background: linear-gradient(120deg, {identity.wash}, transparent 65%)"
					>
						<Sigil slug={realm.slug} size={44} class="mt-0.5 shrink-0" />

						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-baseline gap-2">
								<h2 class="font-semibold">{realm.name}</h2>
								{#if realm.category}
									<Badge variant="outline">{realm.category}</Badge>
								{/if}
							</div>
							<p class="mt-0.5 text-xs text-muted tabular-nums">
								{realm.memberCount}
								{realm.memberCount === 1 ? 'member' : 'members'}
							</p>
						</div>
					</div>

					<div class="flex flex-1 flex-col px-5 pb-5">
						{#if realm.description}
							<p class="line-clamp-3 text-sm leading-relaxed text-muted">{realm.description}</p>
						{/if}

						<ul class="mt-auto flex flex-wrap gap-1.5 pt-4">
							{#each realm.modules as module (module)}
								<li><Badge variant="primary">{MODULE_LABELS[module] ?? 'Module'}</Badge></li>
							{/each}
						</ul>
					</div>
				</a>
			</li>
		{/each}
	</ul>
{/if}
