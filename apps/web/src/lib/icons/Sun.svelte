<script lang="ts">
	/** Sun, shown by the theme toggle when the next click switches to light. */
	let { class: className = 'h-5 w-5' }: { class?: string } = $props();
</script>

<svg
	class={className}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	aria-hidden="true"
>
	<circle cx="12" cy="12" r="4.25" />
	<path
		d="M12 2.5v2M12 19.5v2M4.4 4.4l1.4 1.4M18.2 18.2l1.4 1.4M2.5 12h2M19.5 12h2M4.4 19.6l1.4-1.4M18.2 5.8l1.4-1.4"
	/>
</svg>
