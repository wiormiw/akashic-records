import { describe, expect, test } from 'bun:test';
import { identityOf, sigilRings } from './realm-identity';

/**
 * A realm's face, tested for the properties it actually promises.
 *
 * Nothing here checks a specific colour or a specific number of marks. Those are outputs of a
 * hash, and asserting them would mean the tests fail whenever somebody improves the hash while
 * saying nothing about whether the improvement broke anything.
 *
 * What the module promises is narrower and worth holding: the same realm looks the same
 * everywhere and forever, different realms usually look different, and the marks are drawable.
 */

describe('a realm looks the same everywhere', () => {
	test('the same slug always gives the same identity', () => {
		// The whole point of deriving identity rather than storing it: one realm, one face, on
		// every device, with nothing to load and nothing to keep in sync.
		expect(identityOf('weaboo')).toEqual(identityOf('weaboo'));
	});

	test('the mark is stable for the same seed', () => {
		const seed = identityOf('cosplay').seed;

		expect(sigilRings(seed)).toEqual(sigilRings(seed));
	});

	test('case matters, because a slug is case-insensitive but this is not told so', () => {
		// Worth pinning rather than fixing. Slugs arrive already lowercased from the API, so the
		// two never differ in practice -- but if that ever stops being true, a realm would change
		// colour depending on how it was linked, and this test is where that surfaces.
		expect(identityOf('Weaboo')).not.toEqual(identityOf('weaboo'));
	});
});

describe('different realms look different', () => {
	test('neighbouring names do not land on the same hue', () => {
		// The usual failure of hash-to-hue is a directory of ten realms that reads as three. The
		// golden-angle step is what avoids it, and this is the case that would catch losing it.
		const hues = ['realm-a', 'realm-b', 'realm-c', 'realm-d'].map((s) => identityOf(s).hue);

		expect(new Set(hues).size).toBe(4);
	});

	test('a spread of slugs covers the wheel rather than clustering', () => {
		const slugs = Array.from({ length: 24 }, (_, index) => `realm-${index}`);
		const quadrants = new Set(slugs.map((s) => Math.floor(identityOf(s).hue / 90)));

		// Four quadrants of the colour wheel. Clustering into one or two is exactly what a poor
		// hash-to-hue does, and it is invisible until somebody looks at a full directory.
		expect(quadrants.size).toBe(4);
	});
});

describe('the mark is drawable', () => {
	test('every ring fits inside the 48-unit viewBox', () => {
		for (const slug of ['weaboo', 'cosplay', 'tcg', 'a', 'a-very-long-realm-slug-indeed']) {
			for (const ring of sigilRings(identityOf(slug).seed)) {
				// The SVG is a fixed 48x48 and the centre is 24,24. A radius past that draws outside
				// the box, which clips silently rather than erroring.
				expect(ring.radius).toBeLessThan(24);
				expect(ring.radius).toBeGreaterThan(0);
			}
		}
	});

	test('every mark has a positive size', () => {
		for (const slug of ['weaboo', 'cosplay', 'tcg']) {
			for (const ring of sigilRings(identityOf(slug).seed)) {
				for (const mark of ring.marks) {
					// A zero or negative radius renders nothing, so the realm would appear to have a
					// partly blank mark for no visible reason.
					expect(mark.r).toBeGreaterThan(0);
				}
			}
		}
	});

	test('an empty slug still produces something drawable', () => {
		// The creation form previews the mark as somebody types, so it renders for an empty name
		// before anything has been entered.
		const rings = sigilRings(identityOf('').seed);

		expect(rings.length).toBeGreaterThan(0);
		expect(rings[0]?.marks.length).toBeGreaterThan(0);
	});
});
