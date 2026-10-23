/** A Postgres array literal, bound as one text parameter and cast in SQL (`::citext[]`). */
// Unused today, kept on purpose: CLAUDE.md sends array binds here, because Drizzle on bun:sql
// would otherwise expand the array into a parameter list.
export function pgArray(values: readonly (string | number)[]): string {
	const quoted = values.map(
		(value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
	);
	return `{${quoted.join(',')}}`;
}

/** A pgvector literal, bound as text and cast with `::vector`. */
export const pgVector = (values: readonly number[]): string => `[${values.join(',')}]`;

export const parseVector = (value: string): number[] => JSON.parse(value) as number[];

/** A realm's stored centroid, read as text, as numbers; a realm with none has learned from nothing. */
export const centroidFrom = (
	row: { centroid: string | null; samples: number | null } | undefined,
): { centroid: number[] | null; samples: number } => ({
	centroid: row?.centroid ? parseVector(row.centroid) : null,
	samples: row?.samples ?? 0,
});

/** An ILIKE pattern matching `text` anywhere, with its wildcards escaped. */
export const containing = (text: string): string => `%${text.replaceAll(/[\\%_]/g, '\\$&')}%`;

/** The row the SQL guarantees (scalar subqueries, a one-row RETURNING, an aggregate); any other count is a bug. */
export function one<T>(rows: readonly T[], what: string): T {
	const [row] = rows;
	if (rows.length !== 1 || row === undefined) {
		throw new Error(`expected one ${what}, got ${rows.length}`);
	}
	return row;
}

/** The row a lookup may or may not find; the caller turns `undefined` into its domain error. */
export function first<T>(rows: readonly T[]): T | undefined {
	const [row] = rows;
	return row;
}
