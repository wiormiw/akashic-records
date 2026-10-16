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

/**
 * A timestamp column from a raw `execute` row, which the driver hands back as a Date or as
 * Postgres text ("2026-10-15 12:34:56.789123+00"). Kept to the millisecond, like every other
 * instant read through a Date: `new Date(String(date))` goes through Date's text form, which
 * drops the milliseconds.
 */
export function rowInstant(value: Date | string): Temporal.Instant {
	if (value instanceof Date) return Temporal.Instant.fromEpochMilliseconds(value.getTime());
	const iso = value
		.trim()
		.replace(' ', 'T')
		.replace(/([+-]\d{2})$/, '$1:00');
	return Temporal.Instant.fromEpochMilliseconds(Temporal.Instant.from(iso).epochMilliseconds);
}

/** An ILIKE pattern matching `text` anywhere, with its wildcards escaped. */
export const containing = (text: string): string => `%${text.replaceAll(/[\\%_]/g, '\\$&')}%`;
