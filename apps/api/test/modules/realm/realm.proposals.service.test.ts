import { afterAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { auditEntries, createDb, realmProposals, realms as realmTable, type Tx } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { AuditAction, ProposalStatus, RealmModule, RealmRole } from '@akashic/lib/enums';
import { ErrorCode } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { expectErr, expectOk } from '@akashic/lib/testing';
import type { Embedder } from '@/integrations/embedder.ts';
import { databaseUrl, uniqueSlug } from '../../support/fixtures.ts';
import { knownModules, toProposal } from '@/modules/realm/realm.proposals.service.ts';
import type { ProposalRow } from '@/modules/realm/realm.types.ts';
import { world } from './fixtures.ts';

// The realm service on the real database, each test in a transaction that is rolled back.
// Skips when nothing answers at DATABASE_URL.

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (
	run: (w: ReturnType<typeof world>, tx: Tx) => Promise<void>,
	embedder?: Embedder,
) => withRollback(database.db, (tx) => run(world(tx, embedder), tx));

/** A pending proposal by a fresh account. */
async function proposed(w: ReturnType<typeof world>, slug = uniqueSlug('p')) {
	const proposer = await w.person('Proposer');
	const { id } = expectOk(
		await w.realms.propose({
			slug,
			name: 'Printmakers',
			description: 'Relief, intaglio and the rest.',
			modules: [RealmModule.market],
			rationale: 'There is nowhere else for these people to meet and trade.',
			proposedBy: proposer,
		}),
	);
	return { id, proposer, slug };
}

const auditsOf = (tx: Tx, entityId: string) =>
	tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId));

describe.skipIf(!live)('proposals', () => {
	test('one pending proposal at a time, and never for a taken slug', () =>
		inWorld(async (w) => {
			const { proposer, slug } = await proposed(w);
			expectErr(
				await w.realms.propose({
					slug: `${slug}-2`,
					name: 'Again',
					modules: [],
					rationale: 'x',
					proposedBy: proposer,
				}),
				ErrorCode.realm.duplicateSlug,
			);
			const { slug: taken } = await w.realm();
			expectErr(
				await w.realms.propose({
					slug: taken,
					name: 'Taken',
					modules: [],
					rationale: 'x',
					proposedBy: await w.person(),
				}),
				ErrorCode.realm.duplicateSlug,
			);
		}));

	test('a proposer sees their own, newest first; reviewers see what is pending', () =>
		inWorld(async (w) => {
			const { id, proposer } = await proposed(w);
			const [mine] = await w.realms.myProposals(proposer);
			expect(mine).toMatchObject({
				id,
				status: ProposalStatus.pending,
				modules: [RealmModule.market],
				proposedBy: { id: proposer, name: 'Proposer' },
				decidedAt: null,
			});
			expect((await w.realms.pendingProposals()).some((p) => p.id === id)).toBe(true);
		}));

	test('approval founds the realm with its proposer as admin, announces it, and records the decision', () =>
		inWorld(async (w, tx) => {
			const { id, proposer, slug } = await proposed(w);
			const reviewer = await w.person('Reviewer');

			const { realmId } = expectOk(await w.realms.approve(id, reviewer));
			expect(await w.roleOf(realmId, proposer)).toBe(RealmRole.admin);
			expect((await w.outbox('realm.created', realmId)).length).toBe(1);
			expect((await w.outbox('realm.member_changed', realmId)).map((row) => row.payload)).toEqual([
				{ realmId, userId: proposer, role: RealmRole.admin },
			]);
			const [decided] = await tx.select().from(realmProposals).where(eq(realmProposals.id, id));
			expect(decided).toMatchObject({
				status: ProposalStatus.approved,
				decidedBy: reviewer,
				realmId,
			});
			expect(await auditsOf(tx, id)).toEqual([
				expect.objectContaining({
					userId: reviewer,
					action: AuditAction.updated,
					changes: { approved: true, slug, realmId },
				}),
			]);
			expect(expectOk(await w.realms.read(slug)).modules).toEqual([RealmModule.market]);

			// Decided once.
			expectErr(await w.realms.approve(id, reviewer), ErrorCode.realm.duplicateSlug);
			expectErr(await w.realms.reject(id, reviewer, 'too late'), ErrorCode.realm.notFound);
		}));

	test('approval is one transaction: a failure deciding it leaves no realm behind', () =>
		inWorld(async (w, tx) => {
			const { id, slug } = await proposed(w);
			// No such account, so recording the decision breaks a foreign key after the realm is written.
			await expect(w.realms.approve(id, Bun.randomUUIDv7())).rejects.toThrow();
			expect(await tx.select().from(realmTable).where(eq(realmTable.slug, slug))).toEqual([]);
			const [proposal] = await tx.select().from(realmProposals).where(eq(realmProposals.id, id));
			expect(proposal?.status).toBe(ProposalStatus.pending);
		}));

	test("a proposal that doesn't exist is not found", () =>
		inWorld(async (w) => {
			expectErr(
				await w.realms.approve(Bun.randomUUIDv7(), await w.person()),
				ErrorCode.realm.notFound,
			);
		}));

	test('a slug taken since the proposal was made founds nothing and decides nothing', () =>
		inWorld(async (w, tx) => {
			const { id, slug } = await proposed(w);
			const squatter = await w.person();
			expectOk(await w.realms.found(squatter, { slug, name: 'Squatter', modules: [] }));

			expectErr(await w.realms.approve(id, await w.person()), ErrorCode.realm.duplicateSlug);
			const [proposal] = await tx.select().from(realmProposals).where(eq(realmProposals.id, id));
			expect(proposal).toMatchObject({ status: ProposalStatus.pending, realmId: null });
			expect(await auditsOf(tx, id)).toEqual([]);
		}));

	test('rejection records the note, and only once', () =>
		inWorld(async (w, tx) => {
			const { id, proposer } = await proposed(w);
			const reviewer = await w.person('Reviewer');
			expect(expectOk(await w.realms.reject(id, reviewer, 'Too close to another'))).toEqual({ id });
			const [mine] = await w.realms.myProposals(proposer);
			expect(mine).toMatchObject({
				status: ProposalStatus.rejected,
				decisionNote: 'Too close to another',
				realmId: null,
			});
			expect(mine?.decidedAt).not.toBeNull();
			expect(
				await tx
					.select()
					.from(auditEntries)
					.where(and(eq(auditEntries.entityId, id), eq(auditEntries.userId, reviewer))),
			).toHaveLength(1);
			expectErr(await w.realms.reject(id, reviewer, 'again'), ErrorCode.realm.notFound);
			expectErr(await w.realms.approve(id, reviewer), ErrorCode.realm.duplicateSlug);
		}));
});

describe('proposal row', () => {
	const row: ProposalRow = {
		id: 'p1',
		slug: 'printmakers',
		name: 'Printmakers',
		description: null,
		category: null,
		modules: [],
		rationale: 'Nowhere else.',
		status: ProposalStatus.pending,
		decisionNote: null,
		decidedAt: null,
		realmId: null,
		createdAt: new Date('2026-05-01T00:00:00Z'),
		proposerId: 'u1',
		proposerName: 'Pat',
		proposerEmail: 'pat@example.test',
	};

	test("the proposer's columns become one object, and dates become instants", () => {
		const proposal = toProposal(row);
		expect(proposal.proposedBy).toEqual({ id: 'u1', name: 'Pat', email: 'pat@example.test' });
		expect(proposal.createdAt).toEqual(Temporal.Instant.from('2026-05-01T00:00:00Z'));
		expect(proposal.decidedAt).toBeNull();
		expect('proposerId' in proposal).toBe(false);
	});
});

describe('realm modules', () => {
	test('only modules the code knows, each once, in the order given', () => {
		expect(knownModules([RealmModule.market, 99, RealmModule.jobs, RealmModule.market])).toEqual([
			RealmModule.market,
			RealmModule.jobs,
		]);
	});
});
