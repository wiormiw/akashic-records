<script lang="ts">
	import { RealmRole } from '@akashic/lib/enums';
	import { invalidateAll } from '$app/navigation';
	import { ROLE_LABELS, setRole, type Member } from '#lib/api/realms.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import { staggerChildren } from '#lib/motion.ts';
	import Alert from '#lib/ui/Alert.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Breadcrumbs from '#lib/ui/Breadcrumbs.svelte';
	import Select from '#lib/ui/Select.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Asked of the API rather than derived from the caller's role name, so the controls that render
	// are the ones the API will honour.
	const canVouch = $derived(data.standing.permissions.includes('realm.vouch'));
	const isAdmin = $derived(data.standing.permissions.includes('realm.administer'));

	// A moderator moves people between member and verified; the two staff ranks are an admin's to
	// grant. The API refuses the rest either way — this only decides what to offer.
	const grantable = $derived(
		(
			[
				RealmRole.member,
				RealmRole.verified,
				...(isAdmin ? [RealmRole.moderator, RealmRole.admin] : []),
			] satisfies RealmRole[]
		).map((role) => ({
			value: String(role),
			label: ROLE_LABELS[role] ?? 'Member',
		})),
	);

	const staff = $derived(data.members.filter((member) => member.role >= 2));
	const rest = $derived(data.members.filter((member) => member.role < 2));

	let busy = $state('');
	let error = $state('');

	/** Changes one member's rank. */
	async function change(member: Member, role: string): Promise<void> {
		busy = member.userId;
		error = '';

		try {
			await setRole(data.realm.slug, member.userId, Number(role) as RealmRole); // the select offers only RealmRole values
			await invalidateAll();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not change that.';
		} finally {
			busy = '';
		}
	}

	/**
	 * When somebody joined, short enough to sit under a name.
	 *
	 * @param iso ISO-8601 timestamp.
	 * @returns A month and year.
	 */
	const since = (iso: string): string =>
		new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
</script>

<svelte:head>
	<title>Members · {data.realm.name} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Breadcrumbs
	trail={[
		{ href: '/realms', label: 'Realms' },
		{ href: `/realms/${data.realm.slug}`, label: data.realm.name },
		{ label: 'Members' },
	]}
/>

<div class="mt-4 flex flex-wrap items-baseline gap-3">
	<h1 class="text-2xl font-semibold tracking-tight">Members</h1>
	<span class="text-sm text-muted tabular-nums">{data.members.length} here</span>
</div>

{#if error}
	<Alert variant="warning" class="mt-4" assertive>{error}</Alert>
{/if}

{#snippet row(member: Member)}
	<li
		class="flex flex-wrap items-center gap-3 rounded-app border border-border bg-surface px-3 py-2.5"
	>
		<Avatar name={member.displayName ?? member.name} id={member.userId} image={member.image} />

		<div class="min-w-0 flex-1">
			<p class="truncate font-medium">
				{member.displayName ?? member.name}
				{#if member.userId === data.viewerId}
					<span class="text-xs font-normal text-muted">· you</span>
				{/if}
			</p>
			<p class="text-xs text-muted">Since {since(member.joinedAt)}</p>
		</div>

		{#if canVouch && member.userId !== data.viewerId}
			<Select
				value={String(member.role)}
				options={grantable}
				disabled={busy !== ''}
				aria-label="Role for {member.displayName ?? member.name}"
				class="h-8 text-xs"
				onchange={(event: Event) =>
					change(member, (event.currentTarget as HTMLSelectElement).value)}
			/>
		{:else}
			<Badge variant={member.role >= 2 ? 'primary' : 'neutral'}>
				{ROLE_LABELS[member.role] ?? 'Member'}
			</Badge>
		{/if}
	</li>
{/snippet}

{#if staff.length > 0}
	<h2 class="mt-6 text-xs font-semibold tracking-wide text-muted uppercase">Runs this realm</h2>
	<ul use:staggerChildren={{ each: 0.02 }} class="mt-2 flex flex-col gap-1.5">
		{#each staff as member (member.userId)}{@render row(member)}{/each}
	</ul>
{/if}

<h2 class="mt-6 text-xs font-semibold tracking-wide text-muted uppercase">
	{staff.length > 0 ? 'Everyone else' : 'Everyone'}
</h2>
<ul use:staggerChildren={{ each: 0.02 }} class="mt-2 flex flex-col gap-1.5">
	{#each rest as member (member.userId)}{@render row(member)}{/each}
</ul>

{#if canVouch}
	<p class="mt-5 max-w-2xl text-xs text-muted">
		Vouching says you know somebody is who they say. It grants no extra powers on its own —
		{isAdmin
			? 'moderator and admin do, which is why only you can grant those.'
			: 'moderator and admin do, and only an admin can grant those.'}
		You cannot change your own rank.
	</p>
{/if}
