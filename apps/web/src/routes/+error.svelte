<script lang="ts">
	import { page } from '$app/state';
	import { SITE_NAME } from '$lib/config';
	import Logo from '$lib/icons/Logo.svelte';
	import Button from '$lib/ui/Button.svelte';

	/**
	 * What a reader sees when a page does not exist, or the server could not answer.
	 *
	 * The default is a bare status code on a white page, which reads as the site being broken
	 * rather than the address being wrong. This says which of the two it is and offers the way
	 * back, because a dead end with no exit is what makes somebody close the tab.
	 */
	const messages: Record<number, { title: string; detail: string }> = {
		404: {
			title: 'Nothing at this address',
			detail: 'The page may have moved, or the link may have been mistyped.',
		},
		403: {
			title: 'Not yours to open',
			detail: 'This belongs to a realm you are not a member of.',
		},
		500: {
			title: 'Something broke on our side',
			detail: 'Not your doing. Try again in a moment.',
		},
		503: {
			title: 'A service is not answering',
			detail: 'Something this page needs is down. It should come back on its own.',
		},
	};

	const shown = $derived(
		messages[page.status] ?? {
			title: 'That did not work',
			detail: page.error?.message ?? 'No further detail.',
		},
	);
</script>

<svelte:head>
	<title>{shown.title} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
	<Logo class="h-10 w-10 text-primary opacity-60" />

	<p class="font-mono text-sm text-muted tabular-nums">{page.status}</p>
	<h1 class="text-2xl font-semibold tracking-tight text-balance">{shown.title}</h1>
	<p class="max-w-md text-muted">{shown.detail}</p>

	<div class="mt-4 flex flex-wrap justify-center gap-2">
		<Button href="/realms">Browse realms</Button>
		<Button variant="ghost" href="/">Home</Button>
	</div>
</div>
