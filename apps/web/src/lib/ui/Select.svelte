<script lang="ts">
	import { cn } from './cn';

	/**
	 * A native `<select>`, styled.
	 *
	 * Native rather than a listbox widget: it is keyboard-accessible, screen-reader-correct and
	 * uses the platform picker on mobile for free. A custom one would have to re-earn all three.
	 */
	let {
		value = $bindable(''),
		options,
		class: className = undefined,
		...rest
	}: {
		value?: string;
		/** Rendered in order. An empty `value` is the "no filter" choice. */
		options: { value: string; label: string }[];
		class?: string;
		[key: string]: unknown;
	} = $props();
</script>

<select
	bind:value
	class={cn('h-10 rounded-app border border-border bg-surface px-3 text-sm text-text', className)}
	{...rest}
>
	{#each options as option (option.value)}
		<option value={option.value}>{option.label}</option>
	{/each}
</select>
