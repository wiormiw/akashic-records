import type { Keyring } from './keys';

/**
 * Sealing and opening messages.
 *
 * Everything here happens in the browser. The server sees base64 and a nonce, and there is no
 * point in this file where plaintext could reach it.
 */

/** One device that may open a message, and the wrapped key that lets it. */
export interface Envelope {
	fingerprint: string;
	wrappedKey: string;
	iv: string;
}

/** A sealed message, as it crosses the wire and lands in the database. */
export interface Sealed {
	body: string;
	iv: string;
	/** Detached signature over the plaintext, proving who wrote it. */
	signature: string;
	/** The content key, wrapped once per device that may read it. */
	keys: Envelope[];
}

/** A device to address a message to: its fingerprint and its exchange key. */
export interface Device {
	fingerprint: string;
	publicKey: string;
}

/**
 * Derives the secret shared with one other person.
 *
 * Both sides compute the same key from their own private half and the other's public half — the
 * secret itself never travels, which is what makes this worth doing at all.
 *
 * @param keyring This browser's keys.
 * @param theirPublicKey Their exchange key, JWK-serialised.
 * @returns An AES-GCM key for this conversation.
 *
 * @example
 * const shared = await sharedSecret(keyring, theirs.publicKey);
 */
export async function sharedSecret(keyring: Keyring, theirPublicKey: string): Promise<CryptoKey> {
	const theirs = await crypto.subtle.importKey(
		'jwk',
		JSON.parse(theirPublicKey) as JsonWebKey,
		{ name: 'ECDH', namedCurve: 'P-256' },
		false,
		[],
	);

	return crypto.subtle.deriveKey(
		{ name: 'ECDH', public: theirs },
		keyring.exchange.privateKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

/**
 * Seals a message once and addresses it to every device that should read it.
 *
 * ## Why the key travels and the message does not
 *
 * A person reads on a laptop and a phone; each browser has its own keypair, because a
 * non-extractable key cannot be copied between them. Encrypting the whole message separately for
 * each would multiply the ciphertext by the number of devices. So the body is encrypted once
 * under a content key generated for this message alone, and only that key — 32 bytes — is
 * wrapped for each device under the secret shared with it.
 *
 * The sender's own devices are in that list, or a message would be unreadable to the person who
 * sent it the moment they opened a second browser.
 *
 * The signature is over the **plaintext**, not the ciphertext. Signing ciphertext would prove
 * only that somebody sent those bytes, which the shared key already lets either party produce —
 * signing the words is what makes a disclosed quote checkable against a key only the author has.
 *
 * A fresh nonce per message and per wrap, from the CSPRNG: reusing one under the same key is the
 * single mistake that unravels AES-GCM completely.
 *
 * @param keyring This browser's keys.
 * @param devices Every device that may open it, both people's.
 * @param text What to say.
 * @returns The sealed message, ready to send.
 *
 * @example
 * const sealed = await seal(keyring, [...theirDevices, ...myDevices], 'Can you do 250k?');
 */
export async function seal(keyring: Keyring, devices: Device[], text: string): Promise<Sealed> {
	const plaintext = new TextEncoder().encode(text);
	const iv = crypto.getRandomValues(new Uint8Array(12));

	// Extractable on purpose, and only this one: it has to be wrapped for each recipient. The
	// identity keys in the keyring stay non-extractable and never leave the browser.
	const content = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
		'encrypt',
		'decrypt',
	]);

	const [ciphertext, signature, raw] = await Promise.all([
		crypto.subtle.encrypt({ name: 'AES-GCM', iv }, content, plaintext),
		crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyring.signing.privateKey, plaintext),
		crypto.subtle.exportKey('raw', content),
	]);

	const keys = await Promise.all(
		devices.map(async (device) => {
			const shared = await sharedSecret(keyring, device.publicKey);
			const wrapIv = crypto.getRandomValues(new Uint8Array(12));
			const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, shared, raw);

			return {
				fingerprint: device.fingerprint,
				wrappedKey: toBase64(new Uint8Array(wrapped)),
				iv: toBase64(wrapIv),
			};
		}),
	);

	return {
		body: toBase64(new Uint8Array(ciphertext)),
		iv: toBase64(iv),
		signature: toBase64(new Uint8Array(signature)),
		keys,
	};
}

/**
 * Opens a sealed message addressed to this device.
 *
 * Two steps: unwrap the content key with the secret shared with whichever device sealed it, then
 * decrypt the body with that key.
 *
 * @param keyring This browser's keys.
 * @param senderPublicKey The exchange key of the device that sealed it.
 * @param sealed The stored ciphertext, nonce, and this device's wrapped key.
 * @returns The plaintext, or null when it will not open — tampering, or a wrap made for a key
 *   this browser no longer has. AES-GCM cannot tell those apart, and neither can this.
 *
 * @example
 * const text = await open(keyring, theirDevice.publicKey, message);
 * if (text === null) showUnreadablePlaceholder();
 */
export async function open(
	keyring: Keyring,
	senderPublicKey: string,
	sealed: { body: string; iv: string; wrappedKey: string; keyIv: string },
): Promise<string | null> {
	try {
		const shared = await sharedSecret(keyring, senderPublicKey);

		const raw = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64(sealed.keyIv) },
			shared,
			fromBase64(sealed.wrappedKey),
		);

		const content = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
			'decrypt',
		]);

		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64(sealed.iv) },
			content,
			fromBase64(sealed.body),
		);

		return new TextDecoder().decode(plaintext);
	} catch {
		return null;
	}
}

/**
 * Checks that a message says what its author signed.
 *
 * Used when reading, so a tampered or misattributed message shows as one rather than being
 * quietly rendered as ordinary text.
 *
 * @param theirSigningKey Their signing key, JWK-serialised.
 * @param text The opened plaintext.
 * @param signature The detached signature, base64.
 * @returns True when the signature matches this text from this author.
 *
 * @example
 * const authentic = await verify(theirs.signingKey, text, message.signature);
 */
export async function verify(
	theirSigningKey: string,
	text: string,
	signature: string,
): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey(
			'jwk',
			JSON.parse(theirSigningKey) as JsonWebKey,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		);

		return await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			key,
			fromBase64(signature),
			new TextEncoder().encode(text),
		);
	} catch {
		return false;
	}
}

/**
 * Bytes to base64.
 *
 * @param bytes What to encode.
 * @returns Base64 text.
 *
 * @example
 * toBase64(new Uint8Array([1, 2, 3])); // "AQID"
 */
function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCodePoint(byte);
	return btoa(binary);
}

/**
 * Base64 to bytes.
 *
 * @param text Base64 text.
 * @returns The bytes.
 *
 * @example
 * fromBase64('AQID'); // Uint8Array [1, 2, 3]
 */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));

	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.codePointAt(index) ?? 0;
	}

	return bytes;
}
