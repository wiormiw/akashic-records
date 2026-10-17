<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from './cn';

	/** A surface panel. Everything with its own border and background uses this, so radius and
	 * elevation are defined once. */
	let { class: className = undefined, children }: { class?: string; children: Snippet } = $props();
</script>

<div class={cn('rounded-app border border-border bg-surface', className)}>
	{@render children()}
</div>
