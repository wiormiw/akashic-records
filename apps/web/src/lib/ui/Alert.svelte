<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	/**
	 * A filled notice: a tinted ground behind the text, so a message reads as a message rather
	 * than as another paragraph of body copy.
	 *
	 * The tint carries the meaning, so the three variants are the three things worth saying —
	 * something to know, something that went wrong, something that worked.
	 */
	export const alert = tv({
		base: 'rounded-app border px-4 py-3 text-sm',
		variants: {
			variant: {
				info: 'border-primary/30 bg-primary/10 text-text',
				warning: 'border-accent/40 bg-accent/10 text-text',
				success: 'border-primary/40 bg-primary/15 text-text',
			},
		},
		defaultVariants: { variant: 'info' },
	});

	export type AlertVariant = VariantProps<typeof alert>['variant'];
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from './cn';

	/**
	 * @param title Optional bold first line. Use it when the message has a headline and a body;
	 *   omit it for a single sentence, where a heading would be ceremony.
	 * @param assertive Announce immediately rather than at the next pause. True only for a message
	 *   that appeared *because* of something the reader just did — an unprompted interruption is
	 *   what makes screen readers exhausting.
	 */
	let {
		variant = undefined,
		title = undefined,
		assertive = false,
		class: className = undefined,
		children,
	}: {
		variant?: AlertVariant;
		title?: string;
		assertive?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div class={cn(alert({ variant }), className)} role={assertive ? 'alert' : 'status'}>
	{#if title}
		<p class="font-semibold">{title}</p>
		<div class="mt-1 text-muted">{@render children()}</div>
	{:else}
		{@render children()}
	{/if}
</div>
