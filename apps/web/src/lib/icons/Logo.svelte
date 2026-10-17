<script lang="ts">
	/** The wordmark glyph: concentric rings around a point, for a record of everything. */
	let { class: className = 'h-6 w-6' }: { class?: string } = $props();
</script>

<svg class={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
	<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" opacity="0.35" />
	<circle cx="12" cy="12" r="5.5" stroke="currentColor" stroke-width="1.5" opacity="0.7" />
	<circle cx="12" cy="12" r="2" fill="currentColor" />
</svg>
