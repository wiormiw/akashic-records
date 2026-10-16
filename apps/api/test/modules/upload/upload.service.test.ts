import { describe, expect, test } from 'bun:test';
import { UploadPurpose } from '@akashic/contracts';
import { ContentTooLarge, StorageNotConfigured, ValidationFailed } from '@akashic/lib/errors';
import { isError } from '@akashic/lib/result';
import { createUploadService } from '@/modules/upload/upload.service.ts';
import type { AcceptImageError } from '@/modules/upload/upload.types.ts';
import { expectErr, expectOk, expectType } from '@akashic/lib/testing';
import { JPEG, memoryStore, PNG, WEBP } from './fixtures.ts';

describe('upload service', () => {
	test('files by what the bytes are, whatever the name or declared type says', async () => {
		const { store, stored } = memoryStore();
		const uploads = createUploadService({ store });
		await uploads.acceptImage(
			new File([PNG], 'photo.jpg', { type: 'image/jpeg' }),
			UploadPurpose.listing,
		);
		await uploads.acceptImage(new File([JPEG], 'a'), UploadPurpose.event);
		const { url } = expectOk(
			await uploads.acceptImage(new File([WEBP], 'b'), UploadPurpose.avatar),
		);

		expect(stored).toEqual([
			{ type: 'image/png', prefix: 'listings' },
			{ type: 'image/jpeg', prefix: 'events' },
			{ type: 'image/webp', prefix: 'avatars' },
		]);
		expect(url).toBe('http://cdn.test/avatars/3');
	});

	test("refuses what isn't an image, an empty file, and one over the limit", async () => {
		const uploads = createUploadService({ store: memoryStore().store });
		const refuse = async (file: File, code: AcceptImageError['code']) =>
			expectErr(await uploads.acceptImage(file, UploadPurpose.listing), code);

		await refuse(new File(['GIF89a...'], 'x.gif'), 'common.request.validation_failed');
		await refuse(new File([], 'x.png'), 'common.request.validation_failed');
		const huge = new File([new Uint8Array(uploads.limits().maxBytes + 1)], 'x.png');
		await refuse(huge, 'common.request.payload_too_large');
	});

	test('says so, rather than failing obscurely, when the deployment stores nothing', async () => {
		const uploads = createUploadService({ store: memoryStore(false).store });
		expect(uploads.limits().enabled).toBe(false);
		expectErr(
			await uploads.acceptImage(new File([PNG], 'x.png'), 'listings'),
			'external.storage.not_configured',
		);
	});

	test('narrows a refusal to one error, leaving the rest', async () => {
		const uploads = createUploadService({ store: memoryStore(false).store });
		const unstored = await uploads.acceptImage(new File([PNG], 'x.png'), UploadPurpose.listing);
		if (!isError(unstored, StorageNotConfigured)) throw new Error('expected StorageNotConfigured');
		expect(expectType<StorageNotConfigured>(unstored.error)).toBeInstanceOf(StorageNotConfigured);
		// @ts-expect-error the branch holds only StorageNotConfigured
		expectType<ValidationFailed>(unstored.error);

		const stored = createUploadService({ store: memoryStore().store });
		const empty = await stored.acceptImage(new File([], 'x.png'), UploadPurpose.listing);
		if (empty.ok || isError(empty, StorageNotConfigured)) throw new Error('expected a refusal');
		// StorageNotConfigured is ruled out; the size and content refusals remain.
		expect(expectType<ContentTooLarge | ValidationFailed>(empty.error)).toBeInstanceOf(
			ValidationFailed,
		);
		// @ts-expect-error StorageNotConfigured was narrowed away
		expectType<StorageNotConfigured>(empty.error);
	});
});
