<script lang="ts">
	import Input from './Input.svelte';

	/**
	 * A labelled input with room for one error message.
	 *
	 * The label is a real `<label>` wrapping the control, so clicking it focuses the field and a
	 * screen reader announces the two together without an id to keep in sync.
	 */
	let {
		label,
		value = $bindable(''),
		error = undefined,
		type = 'text',
		...rest
	}: {
		label: string;
		value?: string;
		error?: string;
		type?: string;
		[key: string]: unknown;
	} = $props();
</script>

<label class="block">
	<span class="mb-1.5 block text-sm font-medium">{label}</span>
	<Input bind:value {type} aria-invalid={Boolean(error)} {...rest} />
	{#if error}
		<span class="mt-1 block text-sm text-accent">{error}</span>
	{/if}
</label>
