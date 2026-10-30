<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { grantRealmAdmin, type PlatformRealm } from '#lib/api/platform.ts';
	import Alert from '#lib/ui/Alert.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Input from '#lib/ui/Input.svelte';
	import Sigil from '#lib/ui/Sigil.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let error = $state('');
	let notice = $state('');
	let working = $state('');

	/** Which realm's hand-over form is open, and what has been typed into it. */
	let granting = $state('');
	let grantEmail = $state('');

	/**
	 * Realms with nobody able to run them, first.
	 *
	 * Sorted rather than filtered into a separate list. They are the same realms, and splitting
	 * them out means looking in two places for one community.
	 */
	const realms = $derived(
		[...data.realms].sort((a, b) => {
			const stranded = Number(a.adminCount === 0) - Number(b.adminCount === 0);
			return stranded !== 0 ? -stranded : a.name.localeCompare(b.name);
		}),
	);

	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	/** Hands a realm to somebody by address. */
	async function hand(realm: PlatformRealm): Promise<void> {
		error = '';
		notice = '';
		working = realm.id;

		try {
			await grantRealmAdmin(realm.slug, grantEmail.trim());
			granting = '';
			grantEmail = '';
			await invalidateAll();
			notice = `${realm.name} now has an administrator.`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = '';
		}
	}
</script>

<svelte:head>
	<title>Realms · Control panel</title>
</svelte:head>

<header>
	<h1 class="text-2xl font-semibold tracking-tight">Realms</h1>
	<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
		Every community on the deployment, retired ones included. Nothing else in the API will return an
		archived realm, so this is the only place one can be found again.
	</p>
</header>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}
{#if notice}
	<Alert variant="success" class="mt-4">{notice}</Alert>
{/if}

<ul class="mt-6 flex flex-col gap-2">
	{#each realms as realm (realm.id)}
		<li>
			<Card class="p-4">
				<div class="flex flex-wrap items-start gap-3">
					<Sigil slug={realm.slug} size={36} class="mt-0.5 shrink-0" />

					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<a href="/realms/{realm.slug}" class="font-medium underline-offset-4 hover:underline">
								{realm.name}
							</a>
							{#if realm.archivedAt}
								<Badge variant="outline">retired {when(realm.archivedAt)}</Badge>
							{/if}
							{#if realm.adminCount === 0}
								<Badge variant="accent">no administrator</Badge>
							{/if}
						</div>

						<p class="mt-1 text-sm text-muted">
							{realm.memberCount}
							{realm.memberCount === 1 ? 'member' : 'members'} · founded {when(realm.createdAt)}
							{#if realm.createdBy}
								by {realm.createdBy.name}
							{/if}
						</p>
					</div>

					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							error = '';
							notice = '';
							granting = granting === realm.id ? '' : realm.id;
							grantEmail = '';
						}}
					>
						{granting === realm.id ? 'Cancel' : 'Hand it to somebody'}
					</Button>
				</div>

				{#if granting === realm.id}
					<!-- The narrowest move that unfreezes a community: grant admin to one named account,
					     and let everything after that be done from inside by somebody who belongs there. -->
					<form
						class="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4"
						onsubmit={(event) => {
							event.preventDefault();
							void hand(realm);
						}}
					>
						<label class="min-w-0 flex-1">
							<span class="mb-1 block text-sm">Their email address</span>
							<Input type="email" bind:value={grantEmail} required placeholder="them@example.com" />
						</label>
						<Button disabled={working === realm.id || grantEmail.trim() === ''}>
							{working === realm.id ? 'Granting…' : 'Make them an admin'}
						</Button>
					</form>
					<p class="mt-2 text-xs text-muted">
						They must already have an account. This grants <strong>admin</strong> in
						{realm.name} and nothing else.
					</p>
				{/if}
			</Card>
		</li>
	{/each}
</ul>
