<script lang="ts">
	/** Crescent, shown by the theme toggle when the next click switches to dark. */
	let { class: className = 'h-5 w-5' }: { class?: string } = $props();
</script>

<svg
	class={className}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linejoin="round"
	aria-hidden="true"
>
	<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
</svg>
