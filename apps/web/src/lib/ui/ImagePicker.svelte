<script lang="ts">
	import { uploadImage, type UploadPolicy } from '$lib/api/uploads';
	import Alert from './Alert.svelte';
	import Button from './Button.svelte';

	/**
	 * Choosing a picture for a posting.
	 *
	 * Uploads immediately rather than on submit, so the reader sees the file was accepted while
	 * they are still looking at it — and so a form that fails validation later does not throw the
	 * upload away with it.
	 */
	let {
		purpose,
		policy,
		url = $bindable(''),
		label = 'Picture',
	}: {
		purpose: 'listings' | 'events' | 'avatars';
		policy: UploadPolicy;
		/** The stored URL, bound so the parent can send it with the rest of the form. */
		url?: string;
		label?: string;
	} = $props();

	let busy = $state(false);
	let error = $state('');

	const megabytes = $derived(Math.floor(policy.maxBytes / 1024 / 1024));

	/** Sends whatever was chosen. */
	async function pick(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		busy = true;
		error = '';

		try {
			url = await uploadImage(purpose, file);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not upload that.';
		} finally {
			busy = false;
			// Clears the control so choosing the same file again re-uploads rather than doing nothing.
			input.value = '';
		}
	}
</script>

<div>
	<span class="mb-1.5 block text-sm font-medium">{label}</span>

	{#if url}
		<div class="flex flex-wrap items-center gap-3">
			<img src={url} alt="" class="h-20 w-20 rounded-app border border-border object-cover" />
			<Button size="sm" variant="ghost" onclick={() => (url = '')}>Remove</Button>
		</div>
	{:else if policy.enabled}
		<label
			class="flex h-20 cursor-pointer items-center justify-center rounded-app border border-dashed border-border text-sm text-muted hover:border-primary hover:text-text"
		>
			<input
				type="file"
				accept={policy.imageTypes.join(',')}
				onchange={pick}
				disabled={busy}
				class="sr-only"
			/>
			{busy ? 'Uploading…' : 'Choose a picture'}
		</label>
		<p class="mt-1 text-xs text-muted">
			JPEG, PNG or WebP, up to {megabytes} MB. Optional.
		</p>
	{:else}
		<!-- No object storage on this deployment. The field still takes a URL from anywhere. -->
		<input
			bind:value={url}
			type="url"
			maxlength="500"
			placeholder="https://…"
			class="h-10 w-full rounded-app border border-border bg-surface px-3 text-sm text-text placeholder:text-muted"
		/>
		<p class="mt-1 text-xs text-muted">
			This deployment stores no uploads, so paste a link to one instead. Optional.
		</p>
	{/if}

	{#if error}
		<Alert variant="warning" class="mt-2" assertive>{error}</Alert>
	{/if}
</div>
