import { expect, test } from 'bun:test';
import {
	centroidFrom,
	containing,
	first,
	one,
	parseVector,
	pgArray,
	pgVector,
} from '@akashic/db/sql';

test('array and vector literals bind as one text parameter', () => {
	expect(pgArray(['a', 'b"c'])).toBe('{"a","b\\"c"}');
	expect(pgVector([0.5, 0.25])).toBe('[0.5,0.25]');
	expect(parseVector('[0.5,0.25]')).toEqual([0.5, 0.25]);
	expect(containing('50%_off')).toBe('%50\\%\\_off%');
});

test('a stored centroid is read as numbers; none means nothing learned', () => {
	expect(centroidFrom({ centroid: '[0.5,0.25]', samples: 4 })).toEqual({
		centroid: [0.5, 0.25],
		samples: 4,
	});
	expect(centroidFrom({ centroid: null, samples: null })).toEqual({ centroid: null, samples: 0 });
	expect(centroidFrom(undefined)).toEqual({ centroid: null, samples: 0 });
});

test('one returns the single row and throws, naming it, when there is none', () => {
	expect(one([7], 'count')).toBe(7);
	expect(() => one([], 'platform counts')).toThrow('expected one platform counts, got 0');
	expect(() => one([1, 2], 'platform counts')).toThrow('expected one platform counts, got 2');
});

test('first returns the row or undefined', () => {
	expect(first([1, 2])).toBe(1);
	expect(first([])).toBeUndefined();
});
