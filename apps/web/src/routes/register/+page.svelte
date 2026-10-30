<script lang="ts">
	import * as v from 'valibot';
	import { Registration, resendVerification, signUp } from '#lib/api/auth.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import { revealOnView } from '#lib/motion.ts';
	import BackLink from '#lib/ui/BackLink.svelte';
	import Alert from '#lib/ui/Alert.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Field from '#lib/ui/Field.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let fieldErrors = $state<Record<string, string>>({});
	let formError = $state('');
	let busy = $state(false);
	let sentTo = $state('');
	let resent = $state(false);

	/**
	 * Validates locally, then creates the account.
	 *
	 * No redirect afterwards: verification is required, so there is no session yet. The page
	 * switches to "check your inbox" instead, which is the only true thing to say at that point.
	 *
	 * @param event The submit event, whose default navigation is prevented.
	 */
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		formError = '';

		const parsed = v.safeParse(Registration, { name, email, password });

		if (!parsed.success) {
			fieldErrors = Object.fromEntries(
				parsed.issues.map((issue) => [String(issue.path?.[0]?.key ?? ''), issue.message]),
			);
			return;
		}

		fieldErrors = {};
		busy = true;

		try {
			await signUp(parsed.output);
			sentTo = parsed.output.email;
		} catch (error) {
			formError = error instanceof Error ? error.message : 'Sign-up failed.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Create an account · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="mx-auto max-w-md py-10">
	<BackLink fallback="/" />

	<div use:revealOnView={{ y: 20 }}>
		<Card class="p-6">
			{#if sentTo}
				{#if data.mail && !data.mail.healthy}
					<!-- Mail is known to be failing, so promising an inbox would be a lie the reader
					     cannot check. Say what happened and how to get in anyway. -->
					<h1 class="text-xl font-semibold tracking-tight">
						Account created — but the email failed
					</h1>

					<Alert variant="warning" class="mt-4" assertive>
						<strong>{sentTo}</strong> is registered, and sign-in stays closed until the address is
						confirmed. The confirmation email could not be sent, so ask an operator to confirm the
						account rather than waiting for a link.
						{#if data.mail.lastFailure}
							<span class="mt-2 block text-xs text-muted">
								Reported by the mail provider: {data.mail.lastFailure}
							</span>
						{/if}
					</Alert>
				{:else}
					<h1 class="text-xl font-semibold tracking-tight">Check your inbox</h1>

					<Alert variant="success" class="mt-4" assertive>
						A confirmation link is on its way to <strong>{sentTo}</strong>. You cannot sign in until
						you follow it.
					</Alert>
				{/if}

				<div class="mt-6 flex flex-wrap gap-2">
					<Button href="/login?next=/onboarding">Go to sign in</Button>
					<Button
						variant="outline"
						disabled={resent}
						onclick={async () => {
							await resendVerification(sentTo);
							resent = true;
						}}
					>
						{resent ? 'Link sent again' : 'Resend the link'}
					</Button>
				</div>
			{:else}
				<h1 class="text-xl font-semibold tracking-tight">Create an account</h1>
				<p class="mt-1 text-sm text-muted">
					The engine learns from what you finish and what you quietly drop.
				</p>

				<form class="mt-6 flex flex-col gap-4" onsubmit={submit}>
					<Field
						label="Name"
						bind:value={name}
						error={fieldErrors.name}
						autocomplete="name"
						required
					/>
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
						autocomplete="new-password"
						required
					/>

					{#if formError}
						<p class="text-sm text-accent" role="alert">{formError}</p>
					{/if}

					<Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</Button>
				</form>

				<!-- Stated before the form is filled in, not after: "you cannot sign in yet" is a
				     surprise worth spending three lines to avoid. -->
				<Alert variant="info" class="mt-5">
					We will email you a confirmation link.
					<strong>Sign-in stays closed until you follow it</strong> — so use an address you can open now.
				</Alert>

				<p class="mt-6 text-sm text-muted">
					Already have one?
					<a href="/login" class="underline underline-offset-4">Sign in</a>.
				</p>
			{/if}
		</Card>
	</div>
</div>
