<script lang="ts">
	import { page } from '$app/state';
	import { SITE_NAME } from '#lib/config.ts';
	import { revealOnView } from '#lib/motion.ts';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// better-auth appends ?error=... when a token was expired or already spent.
	const failed = $derived(page.url.searchParams.has('error'));
</script>

<svelte:head>
	<title>{failed ? 'Verification failed' : 'Email verified'} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-md py-12" use:revealOnView={{ y: 20 }}>
	<Card class="p-6 text-center">
		{#if failed}
			<h1 class="text-xl font-semibold tracking-tight">That link did not work</h1>
			<p class="mt-2 text-sm text-muted">
				Verification links expire and can only be used once. Sign in and we will send a fresh one.
			</p>
			<Button href="/login" class="mt-6">Sign in</Button>
		{:else}
			<h1 class="text-xl font-semibold tracking-tight">Email verified</h1>
			<p class="mt-2 text-sm text-muted">
				{#if data.user}
					You are signed in as {data.user.email}.
				{:else}
					Your address is confirmed — sign in and the catalog is yours.
				{/if}
			</p>
			<Button href={data.user ? '/realms' : '/login'} class="mt-6">
				{data.user ? 'Start browsing' : 'Sign in'}
			</Button>
		{/if}
	</Card>
</div>
