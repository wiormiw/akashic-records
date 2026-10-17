/**
 * The reader's own keys, generated here and never sent anywhere.
 *
 * Two keypairs, because they do different jobs and conflating them is the mistake that makes an
 * encrypted system unable to answer "who said this":
 *
 * - **ECDH** derives a secret shared with one other person. Both sides hold the same secret, so
 *   either can encrypt — which is what makes a conversation possible and what makes a decrypted
 *   message prove nothing about its author.
 * - **ECDSA** signs. Only the holder can produce a signature, and anyone with the public half
 *   can check it. That is what turns "he sent me this" from a claim into something checkable.
 *
 * Private halves live in IndexedDB as non-extractable `CryptoKey` objects: the browser will use
 * them and will not hand them back, so no script on the page — including this one — can read the
 * bytes out. Clearing site data destroys them and the messages they could open become
 * unreadable. That is the cost of the server being unable to help.
 */

/** Where the keys live. One store, one record — a personal keyring, not a database. */
const DB_NAME = 'akashic-keys';
const STORE = 'keys';
const RECORD = 'self';

/** The pair of keypairs this browser holds for its reader. */
export interface Keyring {
	exchange: CryptoKeyPair;
	signing: CryptoKeyPair;
}

/** What gets published: the public halves, plus a fingerprint over both. */
export interface PublishedKeys {
	publicKey: string;
	signingKey: string;
	fingerprint: string;
}

/**
 * Opens the keyring database.
 *
 * @returns The database handle.
 *
 * @example
 * const db = await openDb();
 */
async function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);

		request.addEventListener('upgradeneeded', () => {
			if (!request.result.objectStoreNames.contains(STORE)) {
				request.result.createObjectStore(STORE);
			}
		});

		request.addEventListener('success', () => resolve(request.result));
		request.addEventListener('error', () => reject(new Error('Could not open the key store.')));
	});
}

/**
 * Reads or writes the stored keyring.
 *
 * @param mode Whether the transaction may write.
 * @param action What to do with the store.
 * @returns Whatever the action resolved to.
 *
 * @example
 * const stored = await withStore('readonly', (store) => store.get(RECORD));
 */
async function withStore<T>(
	mode: IDBTransactionMode,
	action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const db = await openDb();

	return new Promise((resolve, reject) => {
		const request = action(db.transaction(STORE, mode).objectStore(STORE));
		request.addEventListener('success', () => resolve(request.result));
		request.addEventListener('error', () => reject(new Error('The key store refused that.')));
	});
}

/**
 * Loads this browser's keyring, generating one the first time.
 *
 * Generated non-extractable, so the private halves cannot be exported even by code on this page.
 * That rules out backing them up, deliberately: a key that can be copied out is a key that can
 * be taken.
 *
 * @returns The keyring.
 *
 * @example
 * const keyring = await loadKeyring();
 */
export async function loadKeyring(): Promise<Keyring> {
	const existing = await withStore<Keyring | undefined>('readonly', (store) => store.get(RECORD));
	if (existing) return existing;

	const [exchange, signing] = await Promise.all([
		crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']),
		crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
	]);

	const keyring: Keyring = { exchange, signing };
	await withStore('readwrite', (store) => store.put(keyring, RECORD));

	return keyring;
}

/**
 * Exports the public halves, with a fingerprint over both.
 *
 * The fingerprint covers **both** keys together. Fingerprinting only the exchange key would let
 * a server swap the signing key without changing what two people compare, and signatures would
 * then verify against a key nobody chose.
 *
 * @param keyring This browser's keys.
 * @returns What to publish.
 *
 * @example
 * const published = await exportPublic(keyring);
 */
export async function exportPublic(keyring: Keyring): Promise<PublishedKeys> {
	const [exchangeJwk, signingJwk] = await Promise.all([
		crypto.subtle.exportKey('jwk', keyring.exchange.publicKey),
		crypto.subtle.exportKey('jwk', keyring.signing.publicKey),
	]);

	const publicKey = JSON.stringify(exchangeJwk);
	const signingKey = JSON.stringify(signingJwk);

	return { publicKey, signingKey, fingerprint: await fingerprintOf(publicKey, signingKey) };
}

/**
 * Hashes two public keys into something a human can read aloud.
 *
 * Grouped into blocks of four because that is what people can compare without losing their place
 * — this only works if two people actually check it, and a 64-character string does not get
 * checked.
 *
 * @param publicKey The exchange key, JWK-serialised.
 * @param signingKey The signing key, JWK-serialised.
 * @returns Something like `3f9a 21c7 be04 5d18`.
 *
 * @example
 * await fingerprintOf(publicKey, signingKey); // "3f9a 21c7 be04 5d18"
 */
export async function fingerprintOf(publicKey: string, signingKey: string): Promise<string> {
	const bytes = new TextEncoder().encode(`${publicKey}|${signingKey}`);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

	return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.replace(/(.{4})/gu, '$1 ')
		.trim();
}
