<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import Button from './Button.svelte';

	/**
	 * A back control that behaves like the browser's when it can, and like a link when it cannot.
	 *
	 * Arriving from inside the app, going back should pop history — that restores scroll position
	 * and any state the previous page had. Arriving cold (a shared link, a new tab) there is
	 * nothing to pop, so it navigates to `fallback` instead of stranding the reader.
	 */
	let {
		fallback,
		label = 'Back',
	}: {
		/** Where to go when there is no in-app page to return to. */
		fallback: string;
		label?: string;
	} = $props();

	let cameFromApp = $state(false);

	afterNavigate(({ from }) => {
		cameFromApp = from !== null;
	});

	/** Pops history when there is somewhere to pop to, otherwise follows the fallback. */
	function back(): void {
		if (cameFromApp) history.back();
		else void goto(fallback);
	}
</script>

<!--
	The spacing belongs here rather than at each call site.

	`-ml-3` cancels the ghost button's own padding so its label lines up with the content below
	instead of sitting proud of it, and `mb-4` is the same idea on the other axis: a back control
	always has something directly beneath it, and with no margin the button's hover background
	touches that thing's border. Every page using this had the same gap, which is the signal that
	it was the component's to fix and not theirs.
-->
<Button variant="ghost" size="sm" onclick={back} class="-ml-3 mb-4">
	<span aria-hidden="true">←</span>
	{label}
</Button>
