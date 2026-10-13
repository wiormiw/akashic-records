/** A Postgres array literal, bound as one text parameter and cast in SQL (`::citext[]`). */
// Unused today, kept on purpose: CLAUDE.md sends array binds here, because Drizzle on bun:sql
// would otherwise expand the array into a parameter list.
export function pgArray(values: readonly (string | number)[]): string {
  const quoted = values.map(
    (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return `{${quoted.join(",")}}`;
}

/** A pgvector literal, bound as text and cast with `::vector`. */
export const pgVector = (values: readonly number[]): string => `[${values.join(",")}]`;

export const parseVector = (value: string): number[] => JSON.parse(value) as number[];

/** An ILIKE pattern matching `text` anywhere, with its wildcards escaped. */
export const containing = (text: string): string => `%${text.replaceAll(/[\\%_]/g, "\\$&")}%`;
