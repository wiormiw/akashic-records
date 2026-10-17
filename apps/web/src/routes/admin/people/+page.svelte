<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { setBan, type PlatformAccount } from '$lib/api/platform';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Empty from '$lib/ui/Empty.svelte';
	import Input from '$lib/ui/Input.svelte';
	import Select from '$lib/ui/Select.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let error = $state('');
	let notice = $state('');
	let working = $state('');

	/** Which account's suspension form is open. */
	let banning = $state('');
	let reason = $state('');
	let duration = $state('');

	/**
	 * How long a suspension lasts.
	 *
	 * Fixed choices rather than a date picker. Almost every real suspension is one of these, and a
	 * free date field invites somebody to type a year by accident — which is indistinguishable
	 * from an indefinite ban until the person appeals.
	 */
	const durations = [
		{ value: '', label: 'Indefinite — until somebody lifts it' },
		{ value: '1', label: '24 hours' },
		{ value: '7', label: '7 days' },
		{ value: '30', label: '30 days' },
	];

	const when = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	function clear(): void {
		error = '';
		notice = '';
	}

	/** Turns a number of days into the instant the suspension lifts. */
	function endsAt(days: string): string | null {
		if (!days) return null;

		const end = new Date();
		end.setDate(end.getDate() + Number(days));

		return end.toISOString();
	}

	async function suspend(account: PlatformAccount): Promise<void> {
		clear();
		working = account.id;

		try {
			await setBan(account.id, { reason: reason.trim(), until: endsAt(duration) });
			banning = '';
			reason = '';
			duration = '';
			await invalidateAll();
			notice = `${account.name} is suspended.`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = '';
		}
	}

	async function lift(account: PlatformAccount): Promise<void> {
		clear();
		working = account.id;

		try {
			await setBan(account.id, null);
			await invalidateAll();
			notice = `${account.name} can sign in again.`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work.';
		} finally {
			working = '';
		}
	}

	/**
	 * Whether a suspension is still in force.
	 *
	 * The API evaluates the same comparison on every request, so a row whose end date has passed
	 * is already harmless. Repeating it here stops the list showing "suspended until" a moment in
	 * the past, which reads as the product being broken rather than as the ban having ended.
	 */
	const active = (account: PlatformAccount): boolean =>
		Boolean(account.bannedAt) &&
		(!account.bannedUntil || new Date(account.bannedUntil).getTime() > Date.now());
</script>

<svelte:head>
	<title>People · Control panel</title>
</svelte:head>

<header>
	<h1 class="text-2xl font-semibold tracking-tight">People</h1>
	<p class="mt-1 max-w-prose text-sm leading-relaxed text-muted">
		Every account on the deployment. Suspending one stops them taking part; it does not remove what
		they wrote, because erasing a conversation is a different decision from ending somebody's place
		in it.
	</p>
</header>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}
{#if notice}
	<Alert variant="success" class="mt-4">{notice}</Alert>
{/if}

<form class="mt-6" data-sveltekit-keepfocus>
	<Input
		name="q"
		value={data.query}
		placeholder="Search by name or email"
		aria-label="Search people"
	/>
</form>

{#if data.accounts.length === 0}
	<div class="mt-6">
		<Empty title="Nobody matches that">Search covers the name and the email address.</Empty>
	</div>
{:else}
	<ul class="mt-4 flex flex-col gap-2">
		{#each data.accounts as account (account.id)}
			<li>
				<Card class="p-4">
					<div class="flex flex-wrap items-start gap-3">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-medium">{account.name}</span>
								{#if active(account)}
									<Badge variant="accent">suspended</Badge>
								{/if}
								{#if !account.emailVerified}
									<Badge variant="outline">unverified</Badge>
								{/if}
							</div>

							<p class="mt-0.5 text-sm text-muted">{account.email}</p>

							<p class="mt-1 text-xs text-muted">
								joined {when(account.createdAt)} ·
								{account.realmCount}
								{account.realmCount === 1 ? 'realm' : 'realms'}
							</p>

							{#if active(account) && account.banReason}
								<div class="mt-2 border-l-2 border-border pl-3">
									<p class="text-sm leading-relaxed">{account.banReason}</p>
									<p class="mt-0.5 text-xs text-muted">
										{account.bannedUntil
											? `Lifts on its own ${when(account.bannedUntil)}`
											: 'Indefinite'} · suspended {when(account.bannedAt ?? '')}
									</p>
								</div>
							{/if}
						</div>

						<div class="flex shrink-0 gap-1">
							{#if active(account)}
								<Button
									variant="outline"
									size="sm"
									disabled={working === account.id}
									onclick={() => void lift(account)}
								>
									{working === account.id ? 'Lifting…' : 'Lift suspension'}
								</Button>
							{:else}
								<Button
									variant="ghost"
									size="sm"
									onclick={() => {
										clear();
										banning = banning === account.id ? '' : account.id;
										reason = '';
										duration = '';
									}}
								>
									{banning === account.id ? 'Cancel' : 'Suspend'}
								</Button>
							{/if}
						</div>
					</div>

					{#if banning === account.id}
						<form
							class="mt-4 flex flex-col gap-3 border-t border-border pt-4"
							onsubmit={(event) => {
								event.preventDefault();
								void suspend(account);
							}}
						>
							<label>
								<span class="mb-1 block text-sm">Reason</span>
								<Input bind:value={reason} required placeholder="What they did, in a sentence." />
								<span class="mt-1 block text-xs text-muted">
									<strong>{account.name} will read this.</strong> A suspension nobody can read is indistinguishable
									from the product being broken, and the support burden of that is worse than the argument
									this might cause.
								</span>
							</label>

							<div class="flex flex-wrap items-end gap-3">
								<label class="min-w-0 flex-1">
									<span class="mb-1 block text-sm">Length</span>
									<Select bind:value={duration} options={durations} />
								</label>

								<Button disabled={working === account.id || reason.trim().length < 4}>
									{working === account.id ? 'Suspending…' : 'Suspend'}
								</Button>
							</div>

							<p class="text-xs text-muted">
								Their sessions end immediately. Their postings, comments and library stay exactly
								where they are.
							</p>
						</form>
					{/if}
				</Card>
			</li>
		{/each}
	</ul>
{/if}
