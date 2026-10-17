<script lang="ts">
	import { cn } from './cn';

	/**
	 * A text-shaped input, bound with `$bindable` so a parent can drive it and read it back.
	 *
	 * `type` is passed through for `password` and `email`, which change what the browser's
	 * autofill and mobile keyboard offer.
	 */
	let {
		value = $bindable(''),
		type = 'text',
		class: className = undefined,
		...rest
	}: { value?: string; type?: string; class?: string; [key: string]: unknown } = $props();
</script>

<input
	{type}
	bind:value
	class={cn(
		'h-10 w-full rounded-app border border-border bg-surface px-3 text-sm text-text placeholder:text-muted',
		className,
	)}
	{...rest}
/>
