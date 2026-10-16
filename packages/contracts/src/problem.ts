import * as v from 'valibot';

/** RFC 9457 problem details, as every failure is rendered. */
export const Problem = v.object({
	type: v.string(),
	title: v.string(),
	status: v.number(),
	detail: v.string(),
	code: v.string(),
	details: v.optional(v.record(v.string(), v.unknown())),
	traceId: v.string(),
});
