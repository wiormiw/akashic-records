import * as v from 'valibot';
import { CommentSubject } from '@akashic/lib/enums';

/** Schema pieces more than one module's contract uses. */

/** A moment on the wire: ISO 8601 in UTC. Services hold Temporal.Instant; presenters call `iso`. */
export const Timestamp = v.pipe(v.string(), v.isoTimestamp());
export const iso = (instant: Temporal.Instant): string => instant.toString();
export const isoOrNull = (instant: Temporal.Instant | null): string | null =>
	instant && instant.toString();

export const Uuid = v.pipe(v.string(), v.uuid());

/** What creating something answers: the new id, and nothing else. */
export const Created = v.object({ id: v.string() });
export const IdParam = v.object({ id: Uuid });

/** An integer from a query string (or a number, from a typed client), with bounds and a default. */
export const queryInt = (min: number, max: number, fallback: number) =>
	v.pipe(
		v.optional(v.union([v.string(), v.number()]), fallback),
		v.transform(Number),
		v.integer(),
		v.minValue(min),
		v.maxValue(max),
	);

export const PageLimit = queryInt(1, 200, 50);
export const ListLimit = queryInt(1, 100, 20);

/** Every value of an enum object. */
export const oneOf = <const E extends Record<string, string | number>>(members: E) =>
	v.picklist(Object.values(members) as E[keyof E][]);

export interface TrimmedBounds {
	minLength?: number;
	maxLength?: number;
}

/** A string trimmed before the handler sees it, with its bounds measured after trimming. */
export const trimmed = (options: TrimmedBounds) =>
	v.pipe(
		v.string(),
		v.trim(),
		v.minLength(options.minLength ?? 0),
		v.maxLength(options.maxLength ?? Number.MAX_SAFE_INTEGER),
	);

export interface TrimmedAsSentBounds {
	minLength?: number;
	maxLength: number;
}

/**
 * A string trimmed before the handler sees it, measured as the old API measured: `maxLength` on
 * the text as sent, `minLength` after trimming (so whitespace alone never meets a minimum). Use
 * it for every field the old API declared with `trimmed`, so the same inputs pass.
 */
export const trimmedAsSent = (options: TrimmedAsSentBounds) =>
	v.pipe(v.string(), v.maxLength(options.maxLength), v.trim(), v.minLength(options.minLength ?? 0));

/** A realm's URL name: lowercase words separated by single dashes. */
export const Slug = v.pipe(
	v.string(),
	v.minLength(2),
	v.maxLength(48),
	v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase words separated by single dashes.'),
);

export const RealmSlugParam = v.object({ slug: Slug });
export const RealmItemParam = v.object({ slug: Slug, id: Uuid });
export const RealmMemberParam = v.object({ slug: Slug, userId: Uuid });

const SUBJECT_BY_SEGMENT = {
	events: CommentSubject.event,
	listings: CommentSubject.listing,
	jobs: CommentSubject.job,
} as const;

/** `/realms/:slug/:kind/:id`, where kind names the kind of posting in the URL. */
export const SubjectParam = v.object({
	slug: Slug,
	kind: v.picklist(['events', 'listings', 'jobs']),
	id: Uuid,
});

export interface SubjectPath {
	kind: keyof typeof SUBJECT_BY_SEGMENT;
	id: string;
}

/** The posting a SubjectParam path names. */
export const subjectOf = (params: SubjectPath) => ({
	kind: SUBJECT_BY_SEGMENT[params.kind],
	id: params.id,
});
