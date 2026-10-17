<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	/** Visual variants. `ghost` is for toolbar controls that should not compete with content. */
	export const button = tv({
		base: 'inline-flex items-center justify-center gap-2 rounded-app font-medium transition-[background-color,color,border-color,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
		variants: {
			variant: {
				primary: 'bg-primary text-primary-fg hover:brightness-105',
				outline: 'border border-border bg-surface text-text hover:bg-surface-2',
				ghost: 'text-muted hover:bg-surface-2 hover:text-text',
			},
			size: {
				sm: 'h-8 px-3 text-sm',
				md: 'h-10 px-4 text-sm',
				icon: 'h-10 w-10',
			},
		},
		defaultVariants: { variant: 'primary', size: 'md' },
	});

	export type ButtonVariant = VariantProps<typeof button>['variant'];
	export type ButtonSize = VariantProps<typeof button>['size'];
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { cn } from './cn';

	/**
	 * A button, or a link that looks like one when `href` is set.
	 *
	 * An anchor for navigation rather than a button with an onclick, so middle-click, "open in
	 * new tab" and crawlers all keep working.
	 */
	let {
		variant,
		size,
		href = undefined,
		class: className = undefined,
		children,
		...rest
	}: {
		variant?: ButtonVariant;
		size?: ButtonSize;
		href?: string;
		class?: string;
		children: Snippet;
		[key: string]: unknown;
	} = $props();
</script>

{#if href}
	<a {href} class={cn(button({ variant, size }), className)} {...rest as HTMLAnchorAttributes}>
		{@render children()}
	</a>
{:else}
	<button class={cn(button({ variant, size }), className)} {...rest as HTMLButtonAttributes}>
		{@render children()}
	</button>
{/if}
