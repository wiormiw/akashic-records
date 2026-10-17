<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { signOut } from '$lib/api/auth';
	import { SITE_NAME } from '$lib/config';
	import Logo from '$lib/icons/Logo.svelte';
	import Moon from '$lib/icons/Moon.svelte';
	import Sun from '$lib/icons/Sun.svelte';
	import { theme } from '$lib/theme.svelte';
	import Button from '$lib/ui/Button.svelte';
	import '../app.css';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	onMount(() => theme.sync());

	/**
	 * The main navigation.
	 *
	 * Messages is here rather than only reachable from a listing: a conversation somebody started
	 * yesterday has nowhere to be found otherwise, which is how a reply goes unanswered.
	 */
	const links = $derived(
		[
			{ href: '/realms', label: 'Realms', always: true },
			{ href: '/rooms', label: 'Messages', always: false },
			// Drawn only for somebody who can actually open it. The page 404s for everybody else
			// regardless -- this is so the link is not a dead end, not so the surface is a secret.
			{ href: '/admin', label: 'Platform', always: false, platform: true },
		].filter((link) => ('platform' in link ? data.isPlatformAdmin : link.always || data.user)),
	);

	/** Ends the session, then reloads the layout data so the header stops showing a user. */
	async function leave(): Promise<void> {
		await signOut();
		await invalidateAll();
	}
</script>

<QueryClientProvider client={data.queryClient}>
	<div class="flex min-h-dvh flex-col bg-bg text-text">
		<header class="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur">
			<div class="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-4">
				<a
					href="/"
					class="flex shrink-0 items-center gap-2 font-semibold tracking-tight"
					aria-label={SITE_NAME}
				>
					<Logo class="h-6 w-6 text-primary" />
					<!-- The wordmark is the first thing to go when space runs out; the mark still
					     identifies the site. -->
					<span class="hidden sm:inline">{SITE_NAME}</span>
				</a>

				<!-- Scrolls rather than wraps or pushes the page wide. `min-w-0` is what lets a flex
				     child shrink below its content at all. -->
				<nav class="scrollbar-none -mx-1 min-w-0 flex-1 overflow-x-auto px-1">
					<ul class="flex items-center gap-1 text-sm">
						{#each links as link (link.href)}
							<li>
								<a
									href={link.href}
									aria-current={page.url.pathname.startsWith(link.href) ? 'page' : undefined}
									class="block rounded-app px-2 py-1 whitespace-nowrap transition-colors hover:bg-surface-2"
									class:text-primary={page.url.pathname.startsWith(link.href)}
								>
									{link.label}
								</a>
							</li>
						{/each}
					</ul>
				</nav>

				<div class="flex shrink-0 items-center gap-1">
					{#if data.user}
						<a
							href="/profile"
							class="hidden max-w-[12ch] truncate rounded-app px-2 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text md:inline-block"
						>
							{data.user.name || data.user.email}
						</a>
						<Button variant="ghost" size="sm" onclick={leave}>Sign out</Button>
					{:else}
						<Button variant="ghost" size="sm" href="/login">Sign in</Button>
						<!-- Registration stays one tap away from the sign-in page on small screens. -->
						<Button size="sm" href="/register" class="hidden sm:inline-flex">Create account</Button>
					{/if}

					<Button
						variant="ghost"
						size="icon"
						onclick={() => theme.toggle()}
						aria-label="Switch theme"
						class="h-9 w-9 shrink-0"
					>
						{#if theme.current === 'dark'}
							<Sun />
						{:else}
							<Moon />
						{/if}
					</Button>
				</div>
			</div>
		</header>

		<main class="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
			{@render children()}
		</main>

		<footer class="border-t border-border">
			<div
				class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-6 text-sm text-muted"
			>
				<span>{SITE_NAME}</span>
			</div>
		</footer>
	</div>
</QueryClientProvider>

<style>
	/* The nav scrolls on small screens; a visible scrollbar under it would read as a defect. */
	.scrollbar-none {
		scrollbar-width: none;
	}
	.scrollbar-none::-webkit-scrollbar {
		display: none;
	}
</style>
