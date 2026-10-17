<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	/** `weight` shades a trope badge by how strongly it applies — see the detail page. */
	export const badge = tv({
		base: 'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
		variants: {
			variant: {
				neutral: 'bg-surface-2 text-muted',
				primary: 'bg-primary/15 text-text',
				accent: 'bg-accent/15 text-text',
				outline: 'border border-border text-muted',
			},
		},
		defaultVariants: { variant: 'neutral' },
	});

	export type BadgeVariant = VariantProps<typeof badge>['variant'];
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from './cn';

	let {
		variant = undefined,
		class: className = undefined,
		title = undefined,
		children,
	}: { variant?: BadgeVariant; class?: string; title?: string; children: Snippet } = $props();
</script>

<span class={cn(badge({ variant }), className)} {title}>{@render children()}</span>
