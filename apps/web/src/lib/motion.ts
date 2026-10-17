import { animate, inView, stagger } from 'motion';
import type { Action } from 'svelte/action';

/**
 * Motion, wrapped as Svelte actions.
 *
 * Everything here is an enhancement: the page is complete and readable before any of it runs, so
 * a failed script or `prefers-reduced-motion` costs nothing but the movement.
 */

/** True when the reader asked for less movement. Checked per call, since the setting can change. */
const reducedMotion = (): boolean =>
	typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Spring-ish easing shared by every entrance, so the app has one sense of weight. */
const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Fades and lifts an element into place when it first scrolls into view.
 *
 * @param node The element to animate.
 * @param options `delay` in seconds, and `y` as the distance in pixels to travel.
 * @returns A Svelte action; the observer is disconnected on destroy.
 *
 * @example
 * <section use:revealOnView={{ delay: 0.1 }}>
 */
export const revealOnView: Action<HTMLElement, { delay?: number; y?: number } | undefined> = (
	node,
	options,
) => {
	if (reducedMotion()) return;

	const { delay = 0, y = 16 } = options ?? {};
	node.style.opacity = '0';

	/** Clears the hidden state, whichever path gets here first. */
	const show = (): void => {
		node.style.opacity = '';
	};

	// `amount: 'some'` — any part of the element entering is enough.
	//
	// This was `amount: 0.2`, which means twenty percent of the element's OWN height, and that is
	// unsatisfiable once the element is tall. A grid of 24 recommendation cards is a few thousand
	// pixels high, so it demanded roughly 600px on screen at once; with devtools open the viewport
	// is shorter than that, the observer never fired, and the section sat at opacity 0 forever.
	//
	// The symptom was maddening precisely because everything else was right. The cards were in the
	// DOM, so SvelteKit preloaded each one's detail route and the network tab filled with
	// requests — while the page showed nothing.
	const stop = inView(
		node,
		(element) => {
			show();
			void animate(
				element,
				{ opacity: [0, 1], transform: [`translateY(${y}px)`, 'translateY(0)'] },
				{ duration: 0.5, delay, ease: EASE },
			);
		},
		{ amount: 'some' },
	);

	// The safety net, and the reason this file's opening promise is now true.
	//
	// It says the page is complete and readable before any of this runs. That was false: the line
	// above hides the element synchronously, and only an observer callback ever unhid it. Any
	// failure of that callback, for any reason, left content invisible with no way back.
	//
	// Hiding is an enhancement. STAYING hidden is a bug, and a decoration must not be able to
	// cause one. A second is long past when an entrance would have played.
	const failsafe = setTimeout(show, 1000);

	return {
		destroy() {
			clearTimeout(failsafe);
			stop();
		},
	};
};

/**
 * Reveals a container's children one after another.
 *
 * Used for the catalog grid, where a single fade would hide that several cards arrived while a
 * stagger reads as the page filling in.
 *
 * @param node The container. Its direct element children are animated.
 * @param options `each` is the gap between children in seconds, `from` the index to start at —
 *   pass the previous length when appending a page, so already-visible cards are left alone.
 * @returns A Svelte action that re-runs when `from` changes.
 *
 * @example
 * <ul use:staggerChildren={{ from: previousCount }}>
 */
export const staggerChildren: Action<HTMLElement, { each?: number; from?: number } | undefined> = (
	node,
	options,
) => {
	/**
	 * Animates the children from `from` onwards.
	 *
	 * @param settings The current options.
	 */
	function run(settings: { each?: number; from?: number } | undefined): void {
		if (reducedMotion()) return;

		const { each = 0.04, from = 0 } = settings ?? {};
		const children = [...node.children].slice(from) as HTMLElement[];
		if (children.length === 0) return;

		void animate(
			children,
			{ opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0)'] },
			{ duration: 0.4, delay: stagger(each), ease: EASE },
		);
	}

	run(options);

	return { update: run };
};

/**
 * Moves an element against the pointer, so a flat page gains a little depth.
 *
 * The element is the *layer*, not the tracker: pointer position is read from the window, because
 * a layer that only reacts while hovered stops the moment the cursor crosses a gap.
 *
 * @param node The layer to move.
 * @param options `strength` in pixels at the screen edge. Negative moves against the pointer,
 *   which is what makes two layers read as different distances.
 * @returns A Svelte action; the listener is removed on destroy.
 *
 * @example
 * <div use:parallax={{ strength: 24 }}></div>
 * <div use:parallax={{ strength: -12 }}></div>
 */
export const parallax: Action<HTMLElement, { strength?: number } | undefined> = (node, options) => {
	if (reducedMotion()) return;

	const strength = options?.strength ?? 20;
	let frame = 0;

	/**
	 * Schedules one transform for the next frame.
	 *
	 * @param event The pointer move.
	 */
	function onMove(event: PointerEvent): void {
		cancelAnimationFrame(frame);

		frame = requestAnimationFrame(() => {
			const x = (event.clientX / window.innerWidth - 0.5) * 2;
			const y = (event.clientY / window.innerHeight - 0.5) * 2;

			void animate(
				node,
				{ transform: `translate3d(${x * strength}px, ${y * strength}px, 0)` },
				// Long and soft: the layer trails the cursor rather than tracking it, which is the
				// difference between depth and jitter.
				{ duration: 0.9, ease: 'easeOut' },
			);
		});
	}

	window.addEventListener('pointermove', onMove, { passive: true });

	return {
		destroy() {
			cancelAnimationFrame(frame);
			window.removeEventListener('pointermove', onMove);
		},
	};
};

/**
 * Counts a number up when it first scrolls into view.
 *
 * @param node The element whose text is the number.
 * @param options `value` is the target; `duration` in seconds.
 * @returns A Svelte action. Under reduced motion the final value is written immediately, because
 *   the number is information and only the counting is decoration.
 *
 * @example
 * <span use:countUp={{ value: 26476 }}>0</span>
 */
export const countUp: Action<HTMLElement, { value: number; duration?: number }> = (
	node,
	options,
) => {
	const format = new Intl.NumberFormat();

	if (reducedMotion()) {
		node.textContent = format.format(options.value);
		return;
	}

	node.textContent = '0';

	/** Writes the real value, whichever path gets here first. */
	const settle = (): void => {
		node.textContent = format.format(options.value);
	};

	const stop = inView(
		node,
		() => {
			void animate(0, options.value, {
				duration: options.duration ?? 1.4,
				ease: EASE,
				onUpdate: (latest) => {
					node.textContent = format.format(Math.round(latest));
				},
				onComplete: settle,
			});
		},
		{ amount: 0.6 },
	);

	// The same safety net as revealOnView, and here it matters more.
	//
	// That one leaves content invisible when the observer never fires. This one leaves a WRONG
	// NUMBER on screen — "0 titles" where the answer is 1,500 — which a reader has no reason to
	// doubt. A decoration that fails must degrade to the truth, never to a confident falsehood.
	const failsafe = setTimeout(settle, 2000);

	return {
		destroy() {
			clearTimeout(failsafe);
			stop();
		},
	};
};

/**
 * Scrolls a row of content sideways, forever, and pauses while the pointer is on it.
 *
 * The row must contain its children twice — the animation translates by exactly half its width,
 * so the second copy is what makes the wrap invisible.
 *
 * @param node The row.
 * @param options `seconds` for one full pass, `reverse` to travel the other way.
 * @returns A Svelte action that cancels the animation on destroy.
 *
 * @example
 * <div use:marquee={{ seconds: 40 }}>
 *   {#each [...tropes, ...tropes] as trope}<Chip {trope} />{/each}
 * </div>
 */
export const marquee: Action<HTMLElement, { seconds?: number; reverse?: boolean } | undefined> = (
	node,
	options,
) => {
	if (reducedMotion()) return;

	const { seconds = 40, reverse = false } = options ?? {};
	const from = reverse ? '-50%' : '0%';
	const to = reverse ? '0%' : '-50%';

	const playback = animate(
		node,
		{ transform: [`translateX(${from})`, `translateX(${to})`] },
		{ duration: seconds, ease: 'linear', repeat: Number.POSITIVE_INFINITY },
	);

	/** Pauses so a reader can actually read — and click — what is going past. */
	const hold = () => playback.pause();
	/** Resumes when the pointer leaves. */
	const release = () => playback.play();

	node.addEventListener('pointerenter', hold);
	node.addEventListener('pointerleave', release);
	node.addEventListener('focusin', hold);
	node.addEventListener('focusout', release);

	return {
		destroy() {
			playback.stop();
			node.removeEventListener('pointerenter', hold);
			node.removeEventListener('pointerleave', release);
			node.removeEventListener('focusin', hold);
			node.removeEventListener('focusout', release);
		},
	};
};

/**
 * Tilts an element towards the pointer while it is hovered.
 *
 * @param node The card to tilt.
 * @param options `max` degrees of rotation at the corners.
 * @returns A Svelte action that resets the transform on leave and destroy.
 *
 * @example
 * <div use:tilt={{ max: 6 }}>
 */
export const tilt: Action<HTMLElement, { max?: number } | undefined> = (node, options) => {
	if (reducedMotion()) return;

	const max = options?.max ?? 6;

	/**
	 * Rotates towards the pointer's position within the element.
	 *
	 * @param event The pointer move.
	 */
	function onMove(event: PointerEvent): void {
		const box = node.getBoundingClientRect();
		const x = (event.clientX - box.left) / box.width - 0.5;
		const y = (event.clientY - box.top) / box.height - 0.5;

		void animate(
			node,
			{ transform: `perspective(800px) rotateX(${-y * max}deg) rotateY(${x * max}deg)` },
			{ duration: 0.25, ease: 'easeOut' },
		);
	}

	/** Returns to flat, so a card never keeps a tilt it is no longer being given. */
	function reset(): void {
		void animate(
			node,
			{ transform: 'perspective(800px) rotateX(0deg) rotateY(0deg)' },
			{
				duration: 0.4,
				ease: EASE,
			},
		);
	}

	node.addEventListener('pointermove', onMove);
	node.addEventListener('pointerleave', reset);

	return {
		destroy() {
			node.removeEventListener('pointermove', onMove);
			node.removeEventListener('pointerleave', reset);
		},
	};
};
