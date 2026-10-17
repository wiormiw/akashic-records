/**
 * Giving each realm a face, without asking anyone to draw one.
 *
 * A realm is a community, and a page where every community looks identical reads as a directory
 * rather than a place. Uploaded art would solve that for realms whose founders happen to have
 * some, and leave everyone else with a grey rectangle.
 *
 * So identity is derived from the slug: the same realm is the same colour and the same mark on
 * every device, forever, with nothing stored and nothing to load. A realm that later uploads a
 * banner overrides the mark; until then it still looks like somewhere.
 */

/**
 * A small, stable hash of a string.
 *
 * FNV-1a: a few lines, no dependency, and well-spread for short inputs — which is all that is
 * needed to pick a hue. Not for anything where collisions matter.
 *
 * @param text The slug.
 * @returns An unsigned 32-bit integer.
 *
 * @example
 * hash('weaboo'); // 2463618890
 */
function hash(text: string): number {
	let value = 2_166_136_261;

	for (let index = 0; index < text.length; index++) {
		value ^= text.codePointAt(index) ?? 0;
		value = Math.imul(value, 16_777_619);
	}

	return value >>> 0;
}

/** How a realm looks: a hue, and the seed its mark is drawn from. */
export interface RealmIdentity {
	/** Degrees on the colour wheel. */
	hue: number;
	/** CSS colour for accents, readable on both themes at this lightness. */
	accent: string;
	/** A translucent version, for washes behind content. */
	wash: string;
	seed: number;
}

/**
 * Derives a realm's look from its slug.
 *
 * The hue is spread with a golden-angle step rather than taken straight from the hash, so two
 * realms created together do not land on neighbouring colours — the usual failure of hash-to-hue,
 * where a directory of ten looks like a directory of three.
 *
 * @param slug The realm's slug.
 * @returns Its colours and mark seed.
 *
 * @example
 * const { accent } = identityOf('weaboo');
 */
export function identityOf(slug: string): RealmIdentity {
	const seed = hash(slug);
	const hue = Math.round((seed * 137.508) % 360);

	return {
		hue,
		seed,
		// Held at a saturation and lightness that stay legible against both the cream and the
		// near-black canvas, so one value works in both themes.
		accent: `oklch(0.68 0.15 ${hue})`,
		wash: `oklch(0.68 0.15 ${hue} / 0.14)`,
	};
}

/** One ring of the sigil: its radius, how many marks it carries, and their size. */
export interface SigilRing {
	radius: number;
	marks: { x: number; y: number; r: number }[];
	rotation: number;
}

/**
 * Builds the rings of a realm's sigil.
 *
 * Concentric rings of dots around a centre — the same idea as the site's own mark, so a realm
 * reads as a record within the Records rather than as an unrelated logo. What varies is how many
 * rings, how many marks on each, and how they are rotated, which is enough for realms to be
 * told apart at a glance and at 24px.
 *
 * @param seed From {@link identityOf}.
 * @returns Rings, outermost first, in a 48×48 coordinate space.
 *
 * @example
 * {#each sigilRings(seed) as ring}
 *   {#each ring.marks as mark}<circle cx={mark.x} cy={mark.y} r={mark.r} />{/each}
 * {/each}
 */
export function sigilRings(seed: number): SigilRing[] {
	const rings: SigilRing[] = [];
	const count = 2 + (seed % 2);

	for (let index = 0; index < count; index++) {
		// Each ring reads a different slice of the hash, so its properties vary independently.
		const slice = (seed >>> (index * 5)) % 1024;
		const radius = 8 + index * 7;
		const marks = 5 + (slice % 4) + index;
		const rotation = (slice * 7) % 360;
		const size = 2.4 - index * 0.4;

		rings.push({
			radius,
			rotation,
			marks: Array.from({ length: marks }, (_, mark) => {
				const angle = ((Math.PI * 2) / marks) * mark + (rotation * Math.PI) / 180;

				return {
					x: 24 + Math.cos(angle) * radius,
					y: 24 + Math.sin(angle) * radius,
					r: size,
				};
			}),
		});
	}

	return rings;
}
