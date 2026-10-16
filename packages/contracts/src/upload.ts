import * as v from 'valibot';
import { oneOf } from './common.ts';

// The uploads API contract.

/** Where an upload is filed. The values are the storage prefixes, so they are stored data. */
export const UploadPurpose = { listing: 'listings', event: 'events', avatar: 'avatars' } as const;
export type UploadPurpose = (typeof UploadPurpose)[keyof typeof UploadPurpose];

export const PurposeParam = v.object({ purpose: oneOf(UploadPurpose) });

/** What a deployment accepts; the API's policy supplies it, so contracts do not import config. */
export interface UploadRules {
	imageTypes: readonly string[];
	maxBytes: number;
}

/** The multipart form: one `file` of an accepted type and size. */
export const uploadBody = (rules: UploadRules) =>
	v.object({
		file: v.pipe(
			v.file('Send an image as the `file` field.'),
			v.check((file) => rules.imageTypes.includes(file.type), 'That image type is not accepted.'),
			v.maxSize(rules.maxBytes, 'That file is too large.'),
		),
	});

/** What the client may upload here, so it can refuse a file before sending it. */
export const LimitsView = v.object({
	enabled: v.boolean(),
	imageTypes: v.array(v.string()),
	maxBytes: v.pipe(v.number(), v.integer()),
});
export type Limits = v.InferOutput<typeof LimitsView>;

export const UploadedView = v.object({ url: v.string() });
export type Uploaded = v.InferOutput<typeof UploadedView>;
