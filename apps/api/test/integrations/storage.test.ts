import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@akashic/lib/log';
import { createS3ImageStore } from '@/integrations/storage.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// The S3 store against a real S3 API: the local MinIO from compose.yaml. Skips when none answers.
const endpoint = Bun.env.S3_ENDPOINT ?? 'http://localhost:9000';
const minio = await fetch(`${endpoint}/minio/health/live`).then(
	(r) => r.ok,
	() => false,
);

describe('S3 image store', () => {
	test('without a bucket it is unconfigured, and refuses to store', async () => {
		const store = createS3ImageStore({
			bucket: undefined,
			region: 'us-east-1',
			endpoint,
			publicUrl: undefined,
			accessKeyId: undefined,
			secretAccessKey: undefined,
			logger: silentLogger(),
		});
		expect(store.configured).toBe(false);
		await expect(store.put(PNG, 'image/png', 'listings')).rejects.toThrow('not configured');
	});

	test.skipIf(!minio)(
		'stores under the prefix and returns a URL that serves the same bytes',
		async () => {
			const store = createS3ImageStore({
				bucket: 'akashic',
				region: 'us-east-1',
				endpoint,
				publicUrl: `${endpoint}/akashic/`,
				// compose.yaml's MinIO.
				accessKeyId: Bun.env.S3_ACCESS_KEY_ID ?? 'akashic',
				secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY ?? 'akashic-dev-secret',
				logger: silentLogger(),
			});

			const url = await store.put(PNG, 'image/png', 'test');
			expect(url).toMatch(new RegExp(`^${endpoint}/akashic/test/[0-9a-f-]+\\.png$`));
			const served = await fetch(url);
			expect(served.headers.get('content-type')).toBe('image/png');
			expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
		},
	);
});
