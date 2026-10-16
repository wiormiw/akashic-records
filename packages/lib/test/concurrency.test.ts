import { describe, expect, test } from 'bun:test';
import { createLimiter, mapLimited, mapLimitedSettled } from '@akashic/lib/concurrency';

/** Records the highest number of calls that were ever in flight at once. */
function tracked() {
	let inFlight = 0;
	let peak = 0;
	const work = async (value: number) => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await Bun.sleep(1);
		inFlight -= 1;
		return value * 2;
	};
	return { work, peak: () => peak };
}

describe('concurrency', () => {
	test('mapLimited never exceeds the ceiling and keeps input order', async () => {
		const { work, peak } = tracked();

		const results = await mapLimited([1, 2, 3, 4, 5, 6, 7, 8], 3, work);

		expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
		expect(peak()).toBeLessThanOrEqual(3);
	});

	test('mapLimited with a ceiling of one runs strictly in sequence', async () => {
		const { work, peak } = tracked();

		await mapLimited([1, 2, 3], 1, work);

		expect(peak()).toBe(1);
	});

	test('mapLimitedSettled keeps every result when one item fails', async () => {
		const results = await mapLimitedSettled([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error('bad row');
			return n;
		});

		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
	});

	test('a shared limiter caps work across separate callers', async () => {
		const limit = createLimiter(2);
		const { work, peak } = tracked();

		await Promise.all([
			mapLimited([1, 2, 3], 3, (n) => limit(() => work(n))),
			mapLimited([4, 5, 6], 3, (n) => limit(() => work(n))),
		]);

		expect(peak()).toBeLessThanOrEqual(2);
	});
});
