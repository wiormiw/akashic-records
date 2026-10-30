<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import * as v from 'valibot';
	import { Credentials, resendVerification, signIn } from '#lib/api/auth.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import { revealOnView } from '#lib/motion.ts';
	import BackLink from '#lib/ui/BackLink.svelte';
	import Alert from '#lib/ui/Alert.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Field from '#lib/ui/Field.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let email = $state('');
	let password = $state('');
	let fieldErrors = $state<Record<string, string>>({});
	let formError = $state('');
	let busy = $state(false);
	// better-auth refuses an unverified account, which is a different problem from a wrong
	// password: the credentials were right and there is something the reader can do about it.
	let unverified = $state(false);
	let resent = $state(false);

	/**
	 * Validates locally, then signs in.
	 *
	 * Client-side validation only saves a round trip — the API validates again, and its answer is
	 * what decides.
	 *
	 * @param event The submit event, whose default navigation is prevented.
	 */
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		formError = '';

		const parsed = v.safeParse(Credentials, { email, password });

		if (!parsed.success) {
			fieldErrors = Object.fromEntries(
				parsed.issues.map((issue) => [String(issue.path?.[0]?.key ?? ''), issue.message]),
			);
			return;
		}

		fieldErrors = {};
		unverified = false;
		busy = true;

		try {
			await signIn(parsed.output);
			// The session lives in a cookie the server reads, so the layout has to reload to see it.
			await invalidateAll();
			// Only a same-site path is followed, so `?next=` cannot be used to bounce someone to
			// another origin after they hand over a password.
			const next = page.url.searchParams.get('next');
			await goto(next?.startsWith('/') ? next : '/realms');
		} catch (error) {
			formError = error instanceof Error ? error.message : 'Sign-in failed.';
			unverified = /verif/i.test(formError);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-md py-10">
	<BackLink fallback="/" />

	<div use:revealOnView={{ y: 20 }}>
		<Card class="p-6">
			<h1 class="text-xl font-semibold tracking-tight">Welcome back</h1>
			<p class="mt-1 text-sm text-muted">Sign in to keep a watchlist.</p>

			<form class="mt-6 flex flex-col gap-4" onsubmit={submit}>
				<Field
					label="Email"
					type="email"
					bind:value={email}
					error={fieldErrors.email}
					autocomplete="email"
					required
				/>
				<Field
					label="Password"
					type="password"
					bind:value={password}
					error={fieldErrors.password}
					autocomplete="current-password"
					required
				/>

				{#if unverified}
					<!-- Different from a wrong password: the credentials were right, and there is
					     something the reader can actually do about this one. -->
					<Alert variant="warning" title="Confirm your email first" assertive>
						{#if data.mail && !data.mail.healthy}
							This account is not confirmed yet, and this deployment cannot send email right now —
							so a new link would not arrive either. An operator can confirm it directly.
						{:else}
							We sent a confirmation link to <strong>{email}</strong>. Sign-in stays closed until
							you follow it.
						{/if}
					</Alert>
				{:else if formError}
					<p class="text-sm text-accent" role="alert">{formError}</p>
				{/if}

				<Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>

				{#if unverified && !(data.mail && !data.mail.healthy)}
					<Button
						variant="outline"
						type="button"
						disabled={resent}
						onclick={async () => {
							await resendVerification(email);
							resent = true;
						}}
					>
						{resent ? 'Link sent — check your inbox' : 'Send the verification link again'}
					</Button>
				{/if}
			</form>

			<p class="mt-6 text-sm text-muted">
				No account?
				<a href="/register" class="underline underline-offset-4">Create one</a>.
			</p>
		</Card>
	</div>
</div>
