import type { ImageStore } from '@/integrations/storage.ts';

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
export const WEBP = new Uint8Array([
	...new TextEncoder().encode('RIFF'),
	0,
	0,
	0,
	0,
	...new TextEncoder().encode('WEBP'),
]);

/** A store that remembers what it was given and answers a URL. */
export function memoryStore(configured = true) {
	const stored: { type: string; prefix: string }[] = [];
	const store: ImageStore = {
		configured,
		async put(_bytes, type, prefix) {
			stored.push({ type, prefix });
			return `http://cdn.test/${prefix}/${stored.length}`;
		},
	};
	return { store, stored };
}
