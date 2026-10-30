<script lang="ts">
	import { AUDIT_ACTION } from '#lib/api/platform.ts';
	import Badge from '#lib/ui/Badge.svelte';
	import Empty from '#lib/ui/Empty.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<svelte:head>
	<title>Audit · Control panel</title>
</svelte:head>

<header>
	<h1 class="text-2xl font-semibold tracking-tight">Audit</h1>
	<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
		Administrative acts, newest first. Ordinary use is deliberately absent: logging every library
		entry would bury the handful of entries a year that matter under a million that do not.
	</p>
</header>

{#if data.audit === null}
	<div class="mt-6">
		<Empty title="Couldn't read the audit log">
			The log could not be fetched or understood. Try again; if it keeps failing, the API may be
			sending an entry this version doesn't know.
		</Empty>
	</div>
{:else if data.audit.length === 0}
	<div class="mt-6">
		<Empty title="Nothing recorded yet">
			Renaming a realm, retiring one, changing somebody's rank, removing content — those land here.
		</Empty>
	</div>
{:else}
	<ul class="mt-6 flex flex-col gap-1">
		{#each data.audit as entry (entry.id)}
			<li class="rounded-app border border-border px-4 py-3">
				<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
					<span class="font-medium">{entry.actor?.name ?? 'System'}</span>
					<span class="text-muted">{AUDIT_ACTION[entry.action] ?? `action ${entry.action}`}</span>
					<Badge variant="outline">{entry.entityType}</Badge>
					<span class="ml-auto text-xs text-muted tabular-nums">{when(entry.occurredAt)}</span>
				</div>

				{#if entry.changes}
					<pre
						class="mt-2 overflow-x-auto rounded-app bg-surface-2 px-3 py-2 font-mono text-xs text-muted">{JSON.stringify(
							entry.changes,
							null,
							2,
						)}</pre>
				{/if}

				{#if entry.traceId}
					<!-- The request that caused it. The difference between "the name changed" and "here is
					     everything that happened in the thirty milliseconds around it". -->
					<p class="mt-1 font-mono text-[11px] break-all text-muted">{entry.traceId}</p>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
