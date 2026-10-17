import * as v from 'valibot';

/**
 * Uploading a picture.
 *
 * Deliberately not part of the encrypted rooms. A file nobody can read is a file nobody can
 * check, and that is exactly what material worth prosecuting needs to travel. Everything here is
 * readable by whoever can see the posting it hangs off.
 */

/** What this deployment accepts. */
export const UploadPolicy = v.object({
	enabled: v.boolean(),
	imageTypes: v.array(v.string()),
	maxBytes: v.number(),
});
export type UploadPolicy = v.InferOutput<typeof UploadPolicy>;

/**
 * Asks what may be uploaded.
 *
 * @param options `fetch` to use during SSR.
 * @returns The policy, or a disabled one when the API cannot be reached — a form that cannot
 *   check should offer the URL field rather than a picker that will fail.
 *
 * @example
 * const policy = await uploadPolicy({ fetch });
 */
export async function uploadPolicy(
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<UploadPolicy> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const off: UploadPolicy = { enabled: false, imageTypes: [], maxBytes: 0 };

	try {
		const response = await doFetch('/bff/api/v1/uploads', {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return off;

		const parsed = v.safeParse(UploadPolicy, await response.json());
		return parsed.success ? parsed.output : off;
	} catch {
		return off;
	}
}

/**
 * Sends one image.
 *
 * @param purpose Where it belongs — `listings`, `events` or `avatars`.
 * @param file What the reader chose.
 * @returns The URL to store on the posting.
 * @throws {Error} With the API's wording, which says which rule the file broke.
 *
 * @example
 * const url = await uploadImage('listings', file);
 */
export async function uploadImage(purpose: string, file: File): Promise<string> {
	const form = new FormData();
	form.set('file', file);

	const response = await fetch(`/bff/api/v1/uploads/${purpose}`, { method: 'POST', body: form });
	const answer = (await response.json().catch(() => null)) as {
		url?: string;
		detail?: string;
	} | null;

	if (!response.ok || !answer?.url) throw new Error(answer?.detail ?? 'Could not upload that.');
	return answer.url;
}
