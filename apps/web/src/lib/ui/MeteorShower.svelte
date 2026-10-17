<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Meteors falling across the hero.
	 *
	 * This replaced a single wandering line. That line was drawn as one continuous body which
	 * doubled back on itself, and a body that reverses direction reads as something alive and
	 * lost rather than as atmosphere — the eye follows it, fails to predict it, and keeps coming
	 * back to check. Meteors solve that by being unanimous: every one travels the same bearing at
	 * the same angle, so the field has a direction instead of a personality, and nothing in it
	 * asks to be watched.
	 *
	 * Each streak is one gradient stroke — bright at the head, transparent at the tail — plus a
	 * small radial glow where the head is. Two paints per meteor, no sprite, no image request.
	 *
	 * It never touches layout: absolutely positioned, `pointer-events: none`, and it stops
	 * entirely under `prefers-reduced-motion`, where the page keeps its wash and loses only the
	 * movement.
	 */
	let canvas: HTMLCanvasElement;

	onMount(() => {
		const maybeContext = canvas.getContext('2d');
		if (!maybeContext) return;

		// Bound to a local so the narrowing survives into the callbacks below.
		const context = maybeContext;

		const still = window.matchMedia('(prefers-reduced-motion: reduce)');

		/**
		 * The bearing every meteor travels, as a unit vector.
		 *
		 * Shared rather than randomised per streak, and that is the whole difference between a
		 * meteor shower and a screensaver. A real shower has a radiant: the streaks are parallel
		 * because they are one debris stream seen from one place. Varying the angle per streak
		 * costs nothing and immediately reads as wrong, even to somebody who could not say why.
		 *
		 * Down and to the left, roughly 38 degrees below the horizontal. Shallower than that and
		 * they skim along the headline; steeper and they cross the hero too fast to register.
		 */
		const ANGLE = (142 * Math.PI) / 180;
		const DX = Math.cos(ANGLE);
		const DY = Math.sin(ANGLE);

		/** One streak in flight. */
		interface Meteor {
			x: number;
			y: number;
			/** Pixels per second along the shared bearing. */
			speed: number;
			/** Trail length in pixels. */
			length: number;
			thickness: number;
			/** Seconds since it appeared. */
			age: number;
			/** Seconds before it is clear of the canvas. */
			span: number;
			/** Peak opacity, so a field has near ones and far ones rather than one brightness. */
			bright: number;
			/** True for the accent colour. A minority, or the second colour stops being a highlight. */
			alt: boolean;
		}

		const meteors: Meteor[] = [];

		/** Concurrent streaks. Above this the hero competes with the headline for attention. */
		const MAX = 7;

		/** Seconds between spawns, before jitter. */
		const CADENCE = 0.55;

		let frame = 0;
		let running = false;
		let width = 0;
		let height = 0;
		let last = 0;
		let untilSpawn = 0;

		/** Matches the backing store to the element's CSS size and the display's pixel ratio. */
		function resize(): void {
			const ratio = Math.min(window.devicePixelRatio || 1, 2);
			const box = canvas.getBoundingClientRect();

			width = box.width;
			height = box.height;
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
		}

		/**
		 * A new streak, entering from above and to the right.
		 *
		 * Spawned across a band far wider than the canvas — from a fifth of the way in to well
		 * past the right edge — because a meteor travelling down and left that starts inside the
		 * box only ever covers the left half of it. The ones seeded off to the right are what fill
		 * the right-hand side, and they arrive already moving.
		 *
		 * @returns A meteor at its starting position.
		 */
		function spawn(): Meteor {
			const speed = 420 + Math.random() * 680;

			return {
				x: width * (0.2 + Math.random() * 1.2),
				y: -height * (0.15 + Math.random() * 0.35),
				speed,
				length: 90 + Math.random() * 160,
				thickness: 0.9 + Math.random() * 1.5,
				age: 0,
				// Time to clear the canvas from where it started. Knowing this up front is what lets
				// the fade-out be timed, instead of the streak simply vanishing at the edge.
				span: (height * 1.7) / (speed * DY),
				bright: 0.45 + Math.random() * 0.55,
				alt: Math.random() < 0.3,
			};
		}

		/**
		 * How visible a streak is right now.
		 *
		 * Ramped at both ends. A meteor that appears at full brightness pops, and one cut off at
		 * the edge of the canvas reads as a rendering fault rather than as distance.
		 *
		 * @param meteor The streak.
		 * @returns Opacity between zero and its peak.
		 */
		function fade(meteor: Meteor): number {
			const inward = Math.min(meteor.age / 0.35, 1);
			const outward = Math.min((meteor.span - meteor.age) / 0.6, 1);

			return meteor.bright * inward * Math.max(outward, 0);
		}

		/** Draws one frame. */
		function draw(now: number): void {
			if (!running) return;

			// Clamped, because a backgrounded tab hands back one enormous delta on return. Without
			// this every meteor teleports off the canvas at once and the hero is empty for a second.
			const delta = Math.min((now - last) / 1000, 0.05);
			last = now;

			const style = getComputedStyle(canvas);
			const ink = style.getPropertyValue('--meteor').trim() || '#ffd479';
			const inkAlt = style.getPropertyValue('--meteor-alt').trim() || ink;

			untilSpawn -= delta;

			if (untilSpawn <= 0 && meteors.length < MAX) {
				meteors.push(spawn());
				untilSpawn = CADENCE * (0.5 + Math.random());
			}

			context.clearRect(0, 0, width, height);

			for (let index = meteors.length - 1; index >= 0; index--) {
				const meteor = meteors[index];
				if (!meteor) continue;

				meteor.age += delta;

				if (meteor.age >= meteor.span) {
					meteors.splice(index, 1);
					continue;
				}

				const travelled = meteor.speed * meteor.age;
				const x = meteor.x + DX * travelled;
				const y = meteor.y + DY * travelled;
				const tailX = x - DX * meteor.length;
				const tailY = y - DY * meteor.length;

				const alpha = fade(meteor);
				if (alpha <= 0) continue;

				const colour = meteor.alt ? inkAlt : ink;

				// The trail: a gradient along the streak rather than a stack of segments at
				// decreasing opacity. Same result, one path instead of twenty.
				const trail = context.createLinearGradient(x, y, tailX, tailY);
				trail.addColorStop(0, colour);
				trail.addColorStop(1, 'transparent');

				context.globalAlpha = alpha;
				context.strokeStyle = trail;
				context.lineWidth = meteor.thickness;
				context.lineCap = 'round';
				context.beginPath();
				context.moveTo(x, y);
				context.lineTo(tailX, tailY);
				context.stroke();

				// The head, as a glow rather than a dot. A hard circle at the end of a soft trail
				// looks like a bead on a string; a radial falloff looks like something burning.
				const radius = meteor.thickness * 4;
				const glow = context.createRadialGradient(x, y, 0, x, y, radius);
				glow.addColorStop(0, colour);
				glow.addColorStop(1, 'transparent');

				context.fillStyle = glow;
				context.beginPath();
				context.arc(x, y, radius, 0, Math.PI * 2);
				context.fill();
			}

			context.globalAlpha = 1;
			frame = requestAnimationFrame(draw);
		}

		/** Starts the loop from the current clock, so the first delta is not the page's whole age. */
		function start(): void {
			if (running) return;

			running = true;
			last = performance.now();
			frame = requestAnimationFrame(draw);
		}

		resize();

		// A ResizeObserver, not just the window event.
		//
		// The canvas measures itself with getBoundingClientRect, and at mount that box can still be
		// zero: the section above is laying out, a webfont has not settled, an image has not
		// reserved its space. A zero-sized backing store draws nothing, and re-measuring only on a
		// WINDOW resize leaves it that way until somebody drags the browser edge.
		const observer = new ResizeObserver(() => resize());
		observer.observe(canvas);

		// Seeded mid-flight rather than empty. Waiting out the cadence leaves the hero bare for the
		// first second, which is exactly the second somebody decides whether the page is alive.
		for (let index = 0; index < 4; index++) {
			const seeded = spawn();
			seeded.age = Math.random() * seeded.span * 0.7;
			meteors.push(seeded);
		}

		if (!still.matches) start();

		/** Honours a reader who changes the setting while the page is open. */
		const onPreference = (event: MediaQueryListEvent) => {
			if (event.matches) {
				running = false;
				cancelAnimationFrame(frame);
				context.clearRect(0, 0, width, height);
				return;
			}

			start();
		};

		still.addEventListener('change', onPreference);

		return () => {
			running = false;
			cancelAnimationFrame(frame);
			observer.disconnect();
			still.removeEventListener('change', onPreference);
		};
	});
</script>

<canvas
	bind:this={canvas}
	aria-hidden="true"
	class="pointer-events-none absolute inset-0 h-full w-full [--meteor-alt:var(--color-accent)] [--meteor:var(--color-primary)]"
></canvas>
