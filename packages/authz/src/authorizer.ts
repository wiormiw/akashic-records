import {
	ClientWriteRequestOnDuplicateWrites,
	ClientWriteRequestOnMissingDeletes,
	OpenFgaClient,
	type TupleKey,
} from '@openfga/sdk';
import { AuthzUnavailable } from '@akashic/lib/errors';
import { isAbortOf, untilAborted } from '@akashic/lib/abort';
import { traced } from '@akashic/lib/tracing';
import type { Logger } from '@akashic/lib/log';
import { FgaType, type Authorizer, type Tuple } from './vocabulary.ts';

export interface OpenFgaOptions {
	apiUrl: string;
	storeId: string;
	modelId?: string | undefined;
	/** Per HTTP request; the SDK retries a failed one a few times, each with this bound. */
	timeoutMs: number;
	logger: Logger;
}

const ref = (type: string, id: string) => `${type}:${id}`;
const userRef = (userId: string) => ref(FgaType.user, userId);

const toTupleKey = (tuple: Tuple): TupleKey => ({
	user:
		'userId' in tuple.subject
			? userRef(tuple.subject.userId)
			: ref(tuple.subject.type, tuple.subject.objectId),
	relation: tuple.relation,
	object: ref(tuple.type, tuple.objectId),
});

const identity = (tuple: TupleKey) => `${tuple.user} ${tuple.relation} ${tuple.object}`;

export function createAuthorizer(options: OpenFgaOptions): Authorizer {
	const log = options.logger.child({ component: 'authz' });
	const client = new OpenFgaClient({
		apiUrl: options.apiUrl,
		storeId: options.storeId,
		authorizationModelId: options.modelId,
		// Spread into every axios request the SDK makes. Without it a hung OpenFGA hangs the caller:
		// the SDK takes no AbortSignal, so this is the only thing that ends the request itself.
		baseOptions: { timeout: options.timeoutMs },
	});

	async function call<T>(
		operation: string,
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		signal?.throwIfAborted();
		try {
			return await untilAborted(run(), signal);
		} catch (error) {
			// The caller gave up (deadline, disconnect, shutdown): not an outage, so not logged as one.
			if (isAbortOf(error, signal)) throw error;
			log.error({ err: error, operation }, 'openfga call failed');
			throw new AuthzUnavailable('Could not check your permissions just now.', { cause: error });
		}
	}

	return {
		check: (check, signal) =>
			traced(
				'authz.check',
				{ 'akashic.fga.type': check.type, 'akashic.fga.relation': check.relation },
				() =>
					call('check', signal, async () => {
						const { allowed } = await client.check({
							user: userRef(check.userId),
							relation: check.relation,
							object: ref(check.type, check.objectId),
						});
						return allowed ?? false;
					}),
				{ signal },
			),

		checkMany: (checks, signal) =>
			traced(
				'authz.check_many',
				{ 'akashic.fga.count': checks.length },
				async () => {
					if (checks.length === 0) return [];
					const { result } = await call('batchCheck', signal, () =>
						client.batchCheck({
							checks: checks.map((c, i) => ({
								user: userRef(c.userId),
								relation: c.relation,
								object: ref(c.type, c.objectId),
								correlationId: String(i),
							})),
						}),
					);
					const byId = new Map(result.map((answer) => [answer.correlationId, answer]));
					// An item the batch failed to answer is a denial, not an outage.
					return checks.map((_, i) => byId.get(String(i))?.allowed ?? false);
				},
				{ signal },
			),

		write: (changes, signal) =>
			traced(
				'authz.write',
				{
					'akashic.fga.writes': changes.writes?.length ?? 0,
					'akashic.fga.deletes': changes.deletes?.length ?? 0,
				},
				async () => {
					const writes = (changes.writes ?? []).map(toTupleKey);
					// A tuple both written and deleted in one call would make OpenFGA reject the batch.
					const written = new Set(writes.map(identity));
					const deletes = (changes.deletes ?? [])
						.map(toTupleKey)
						.filter((tuple) => !written.has(identity(tuple)));
					if (writes.length === 0 && deletes.length === 0) return;

					await call('write', signal, () =>
						client.write(
							{ writes, deletes },
							{
								conflict: {
									onDuplicateWrites: ClientWriteRequestOnDuplicateWrites.Ignore,
									onMissingDeletes: ClientWriteRequestOnMissingDeletes.Ignore,
								},
							},
						),
					);
				},
				{ signal },
			),

		listObjects: (userId, relation, type, signal) =>
			traced(
				'authz.list_objects',
				{ 'akashic.fga.type': type, 'akashic.fga.relation': relation },
				async () => {
					const { objects } = await call('listObjects', signal, () =>
						client.listObjects({ user: userRef(userId), relation, type }),
					);
					return objects.map((object) => object.slice(object.indexOf(':') + 1));
				},
				{ signal },
			),
	};
}
