<script lang="ts">
	import { page } from '$app/state';
	import { SITE_NAME } from '#lib/config.ts';
	import Badge from '#lib/ui/Badge.svelte';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	/** The panel's sections. Badges mark queues waiting for a person, not statistics. */
	const sections = $derived([
		{
			group: 'Governance',
			items: [
				{
					href: '/admin/proposals',
					label: 'Proposals',
					// No badge from the overview: the count is not in it, and a second request per page
					// load to colour one label is a poor trade. The page itself says how many.
					badge: null,
				},
				{
					href: '/admin/realms',
					label: 'Realms',
					// Only realms with nobody running them. A count of all realms is a statistic; a
					// count of stranded ones is a thing to go and do.
					badge: data.overview.orphaned > 0 ? String(data.overview.orphaned) : null,
				},
				{
					href: '/admin/reports',
					label: 'Reports',
					badge: data.overview.openReports > 0 ? String(data.overview.openReports) : null,
				},
				// No badge. A count of suspended accounts is a statistic, not a queue — nobody has to
				// act on it, and a permanent number in the sidebar trains people to ignore badges.
				{ href: '/admin/people', label: 'People', badge: null },
				{ href: '/admin/audit', label: 'Audit', badge: null },
			],
		},
	]);

	/** True for the section the reader is in. Exact on the index so it is not always current. */
	const isCurrent = (href: string): boolean =>
		href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href);
</script>

<svelte:head>
	<!-- Nothing here should ever be indexed, and it 404s for everybody else regardless. -->
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="flex flex-col gap-8 lg:flex-row">
	<!-- A sidebar on a wide screen, an ordinary stack of links on a phone. No drawer: this is a
	     tool used at a desk, and a control it hides is a control somebody cannot find. -->
	<aside class="lg:w-52 lg:shrink-0">
		<a href="/admin" class="block">
			<p class="text-xs tracking-widest text-muted uppercase">{SITE_NAME}</p>
			<h2 class="text-lg font-semibold tracking-tight" class:text-primary={isCurrent('/admin')}>
				Control panel
			</h2>
		</a>

		<nav class="mt-5 flex flex-col gap-5">
			{#each sections as section (section.group)}
				<div>
					<p class="mb-1 text-xs tracking-wide text-muted uppercase">{section.group}</p>
					<ul class="flex flex-col">
						{#each section.items as item (item.href)}
							<li>
								<a
									href={item.href}
									aria-current={isCurrent(item.href) ? 'page' : undefined}
									class="flex items-center gap-2 rounded-app px-2 py-1.5 text-sm transition-colors hover:bg-surface-2"
									class:bg-surface-2={isCurrent(item.href)}
									class:text-primary={isCurrent(item.href)}
								>
									<span class="flex-1">{item.label}</span>
									{#if item.badge}
										<Badge variant="accent">{item.badge}</Badge>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</nav>
	</aside>

	<div class="min-w-0 flex-1">
		{@render children()}
	</div>
</div>
