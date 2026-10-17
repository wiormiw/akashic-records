import { describe, expect, test } from 'bun:test';
import { exportPublic, fingerprintOf, type Keyring } from './keys';
import { open, seal, verify, type Device } from './messages';

/**
 * End-to-end encryption for rooms, tested for the first time.
 *
 * # Why this file matters more than its size suggests
 *
 * Rooms have carried zero messages. Every line of this module has been written, reviewed and
 * deployed, and none of it has ever run against real input — so "it works" was an assumption, not
 * an observation. Encryption is the worst place for that: a bug here is silent. A message that
 * fails to seal throws and somebody notices; a message that seals against the wrong key, or a
 * signature that verifies when it should not, looks exactly like success.
 *
 * # Why the keyring is built here rather than loaded
 *
 * `loadKeyring` reads IndexedDB, which does not exist outside a browser. Everything worth testing
 * takes a keyring as a parameter, so these build one the same way `loadKeyring` would and skip
 * the storage entirely. That is a property of the module's shape rather than a trick: the
 * cryptography was already separated from where the keys live.
 */

/**
 * A keyring, generated exactly as `loadKeyring` generates one.
 *
 * Non-extractable, like the real thing. If these were extractable the tests would pass while
 * testing a weaker configuration than the one that ships.
 */
async function keyring(): Promise<Keyring> {
	const [exchange, signing] = await Promise.all([
		crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']),
		crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
	]);

	return { exchange, signing };
}

/** The device entry one keyring publishes, for addressing a message to it. */
async function deviceOf(ring: Keyring): Promise<Device> {
	const published = await exportPublic(ring);

	return { fingerprint: published.fingerprint, publicKey: published.publicKey };
}

/** Picks the envelope addressed to one device, as a reader's client would. */
function envelopeFor(sealed: Awaited<ReturnType<typeof seal>>, device: Device) {
	const envelope = sealed.keys.find((key) => key.fingerprint === device.fingerprint);

	if (!envelope) throw new Error('no envelope for that device');

	return { body: sealed.body, iv: sealed.iv, wrappedKey: envelope.wrappedKey, keyIv: envelope.iv };
}

describe('sealing and opening', () => {
	test('the recipient reads what the sender wrote', async () => {
		const alice = await keyring();
		const bob = await keyring();

		const alicePublic = await exportPublic(alice);
		const sealed = await seal(alice, [await deviceOf(bob)], 'Can you do 250k?');

		const text = await open(bob, alicePublic.publicKey, envelopeFor(sealed, await deviceOf(bob)));

		expect(text).toBe('Can you do 250k?');
	});

	test('the sender can read their own message back', async () => {
		const alice = await keyring();
		const bob = await keyring();

		// Addressed to both, which is what the real caller does — otherwise the sender cannot see
		// their own sent messages after a reload.
		const devices = [await deviceOf(bob), await deviceOf(alice)];
		const alicePublic = await exportPublic(alice);
		const sealed = await seal(alice, devices, 'Sent from my own device.');

		const text = await open(
			alice,
			alicePublic.publicKey,
			envelopeFor(sealed, await deviceOf(alice)),
		);

		expect(text).toBe('Sent from my own device.');
	});

	test('a device the message was not addressed to gets nothing', async () => {
		const alice = await keyring();
		const bob = await keyring();
		const carol = await keyring();

		const alicePublic = await exportPublic(alice);
		const sealed = await seal(alice, [await deviceOf(bob)], 'Not for Carol.');

		// Carol takes Bob's envelope and tries it with her own keys, which is the whole attack: the
		// ciphertext is public, so the only thing stopping her is that the wrap was not made for her.
		const stolen = envelopeFor(sealed, await deviceOf(bob));

		expect(await open(carol, alicePublic.publicKey, stolen)).toBeNull();
	});

	test('a tampered body does not open', async () => {
		const alice = await keyring();
		const bob = await keyring();

		const alicePublic = await exportPublic(alice);
		const sealed = await seal(alice, [await deviceOf(bob)], 'Transfer 250k.');
		const envelope = envelopeFor(sealed, await deviceOf(bob));

		// One flipped character in the base64. AES-GCM authenticates, so this must fail rather than
		// decrypt to something else.
		const corrupted = {
			...envelope,
			body: envelope.body.slice(0, -2) + (envelope.body.endsWith('A') ? 'B' : 'A') + '=',
		};

		expect(await open(bob, alicePublic.publicKey, corrupted)).toBeNull();
	});

	test('unicode survives the round trip', async () => {
		const alice = await keyring();
		const bob = await keyring();

		// The encoder and decoder are the only thing between a reader and mojibake, and Japanese is
		// not a hypothetical audience for this product.
		const text = 'コスプレの型紙、まだ余ってる？ 🧵';
		const alicePublic = await exportPublic(alice);
		const sealed = await seal(alice, [await deviceOf(bob)], text);

		expect(await open(bob, alicePublic.publicKey, envelopeFor(sealed, await deviceOf(bob)))).toBe(
			text,
		);
	});

	test('every addressed device gets its own envelope', async () => {
		const alice = await keyring();
		const phone = await keyring();
		const laptop = await keyring();

		const devices = [await deviceOf(phone), await deviceOf(laptop)];
		const sealed = await seal(alice, devices, 'Two devices, one message.');

		expect(sealed.keys).toHaveLength(2);
		// One body, wrapped keys per device. Encrypting the body per device would multiply storage
		// by the number of devices for no gain.
		expect(new Set(sealed.keys.map((k) => k.wrappedKey)).size).toBe(2);
	});
});

describe('signatures', () => {
	test('a signature verifies against the text its author signed', async () => {
		const alice = await keyring();
		const bob = await keyring();

		const alicePublic = await exportPublic(alice);
		const sealed = await seal(alice, [await deviceOf(bob)], 'I agree to the price.');

		expect(await verify(alicePublic.signingKey, 'I agree to the price.', sealed.signature)).toBe(
			true,
		);
	});

	test('a different text does not verify', async () => {
		const alice = await keyring();
		const bob = await keyring();

		const alicePublic = await exportPublic(alice);
		const sealed = await seal(alice, [await deviceOf(bob)], 'I agree to the price.');

		// The case the signature exists for: somebody shows a message claiming it said something else.
		expect(await verify(alicePublic.signingKey, 'I agree to 500k.', sealed.signature)).toBe(false);
	});

	test('a different author does not verify', async () => {
		const alice = await keyring();
		const bob = await keyring();
		const carol = await keyring();

		const carolPublic = await exportPublic(carol);
		const sealed = await seal(alice, [await deviceOf(bob)], 'Alice wrote this.');

		// Misattribution: a message really sealed by Alice, presented as Carol's.
		expect(await verify(carolPublic.signingKey, 'Alice wrote this.', sealed.signature)).toBe(false);
	});

	test('a malformed signing key answers false rather than throwing', async () => {
		// Reading a room must not crash because one stored key is corrupt. The reader should see a
		// message marked unverified, not a blank screen.
		expect(await verify('not json', 'anything', 'AAAA')).toBe(false);
	});
});

describe('fingerprints', () => {
	test('cover both keys, so neither can be swapped unnoticed', async () => {
		const ring = await keyring();
		const other = await keyring();

		const published = await exportPublic(ring);
		const swapped = await exportPublic(other);

		// Fingerprinting only the exchange key would let a server substitute the signing key without
		// changing what two people compare, and signatures would then verify against a key nobody
		// chose. Mixing one key from each keyring must produce a third fingerprint.
		const mixed = await fingerprintOf(published.publicKey, swapped.signingKey);

		expect(mixed).not.toBe(published.fingerprint);
		expect(mixed).not.toBe(swapped.fingerprint);
	});

	test('are stable for the same pair of keys', async () => {
		const ring = await keyring();
		const published = await exportPublic(ring);

		// Two people comparing fingerprints out of band is the only defence against a substituted
		// key, and it is worthless if the value moves between reads.
		expect(await fingerprintOf(published.publicKey, published.signingKey)).toBe(
			published.fingerprint,
		);
	});

	test('differ between keyrings', async () => {
		const a = await exportPublic(await keyring());
		const b = await exportPublic(await keyring());

		expect(a.fingerprint).not.toBe(b.fingerprint);
	});
});
