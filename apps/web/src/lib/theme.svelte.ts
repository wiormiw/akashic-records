import { browser } from '$app/environment';

/** What the reader chose. `system` means no override — the OS decides via `prefers-color-scheme`. */
export type Theme = 'system' | 'light' | 'dark';

/**
 * The theme override, persisted per browser.
 *
 * The initial value is read from the DOM rather than from storage, because `app.html` has
 * already applied it before hydration — reading it back keeps the toggle in step with what is
 * on screen instead of flashing to a default.
 */
class ThemeState {
	current = $state<Theme>('system');

	/**
	 * Reads the attribute `app.html` set, so the store starts where the page already is.
	 *
	 * @example
	 * onMount(() => theme.sync());
	 */
	sync(): void {
		if (!browser) return;
		const applied = document.documentElement.dataset.theme;
		this.current = applied === 'dark' || applied === 'light' ? applied : 'system';
	}

	/**
	 * Switches to the opposite of what is currently rendered and remembers it.
	 *
	 * From `system` it picks the opposite of what the OS is showing, so the first click always
	 * visibly changes something.
	 *
	 * @example
	 * <button onclick={() => theme.toggle()}>
	 */
	toggle(): void {
		if (!browser) return;

		const showingDark =
			this.current === 'dark' ||
			(this.current === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

		this.current = showingDark ? 'light' : 'dark';
		document.documentElement.dataset.theme = this.current;

		// A private window can refuse storage; the theme still applies for this page.
		try {
			localStorage.setItem('theme', this.current);
		} catch {
			/* not persisted */
		}
	}
}

/** The single theme store. One per document, so a module-level instance is the right scope. */
export const theme = new ThemeState();
