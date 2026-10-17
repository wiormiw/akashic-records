<script lang="ts">
	import { resendVerification } from '$lib/api/auth';
	import { SITE_NAME } from '$lib/config';
	import { revealOnView } from '$lib/motion';
	import { badgesFor, discriminator, initials, memberSince } from '$lib/profile';
	import Alert from '$lib/ui/Alert.svelte';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const user = $derived(data.user);
	const badges = $derived(badgesFor(user));
	const earned = $derived(badges.filter((badge) => badge.earned));
	const since = $derived(memberSince(user.createdAt));
	const displayName = $derived(user.name?.trim() || user.email.split('@')[0]);

	let resent = $state(false);
	let resending = $state(false);

	/** Asks for another verification link, and says so rather than silently succeeding. */
	async function resend(): Promise<void> {
		resending = true;
		try {
			await resendVerification(user.email);
			resent = true;
		} finally {
			resending = false;
		}
	}
</script>

<svelte:head>
	<title>{displayName}#{discriminator(user.id)} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if !user.emailVerified}
	<!-- Stated plainly rather than left as a greyed-out badge: it is the one thing here to act on. -->
	<Card class="mb-4 flex flex-wrap items-center gap-3 border-primary/40 p-4">
		<div>
			<p class="text-sm font-semibold">Your email is not confirmed yet</p>
			<p class="mt-0.5 text-sm text-muted">
				The account is unverified until you follow the link sent to {user.email}.
			</p>
		</div>
		<Button class="ml-auto" size="sm" disabled={resending || resent} onclick={resend}>
			{resent ? 'Link sent' : resending ? 'Sending…' : 'Resend the link'}
		</Button>
	</Card>
{/if}

<div use:revealOnView={{ y: 16 }}>
	<Card class="overflow-hidden">
		<!-- Banner. Decorative, and deliberately not `relative`: a positioned banner paints above
		     the static content below it, which is what was clipping the avatar in half. -->
		<div aria-hidden="true" class="h-24 bg-surface-2 [clip-path:inset(0)]">
			<div
				class="h-full w-full bg-[radial-gradient(120%_140%_at_15%_0%,var(--color-primary)_0%,transparent_55%),radial-gradient(120%_140%_at_85%_10%,var(--color-accent)_0%,transparent_50%)] opacity-30"
			></div>
		</div>

		<div class="px-6 pb-6">
			<!-- The avatar overhangs the banner, so it needs to sit above it in paint order. -->
			<div class="relative z-10 -mt-12 flex flex-wrap items-end gap-4">
				{#if user.image}
					<img
						src={user.image}
						alt=""
						class="h-24 w-24 rounded-full border-4 border-surface object-cover"
					/>
				{:else}
					<div
						aria-hidden="true"
						class="flex h-24 w-24 items-center justify-center rounded-full border-4 border-surface bg-primary text-2xl font-semibold text-primary-fg"
					>
						{initials(user)}
					</div>
				{/if}

				<div class="min-w-0 pb-1">
					<h1 class="text-2xl leading-tight font-semibold tracking-tight">
						{displayName}<span class="font-normal text-muted">#{discriminator(user.id)}</span>
					</h1>
					<p class="text-sm break-all text-muted">{user.email}</p>
				</div>

				<div class="ml-auto pb-1">
					<Button href="/realms" size="sm">Your realms</Button>
				</div>
			</div>

			<div class="mt-4 flex flex-wrap gap-1.5">
				{#each earned as badge (badge.slug)}
					<Badge variant={badge.tone} title={badge.description}>{badge.label}</Badge>
				{/each}
				{#if since}
					<Badge variant="outline">Member since {since}</Badge>
				{/if}
			</div>
		</div>
	</Card>
</div>
