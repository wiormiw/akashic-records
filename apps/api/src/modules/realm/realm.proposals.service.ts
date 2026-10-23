import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { Proposal } from '@akashic/contracts';
import { realmEvents } from '@akashic/contracts/events';
import {
	audit,
	inTransaction,
	publish,
	realmMembers,
	realmModules,
	realmProposals,
	realms,
	type Tx,
	user,
} from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { AuditAction, ProposalStatus, RealmModule, RealmRole } from '@akashic/lib/enums';
import { DuplicateSlug, RealmNotFound } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import { policy } from '@/config.ts';
import type {
	ApproveError,
	ApprovedRealm,
	FoundRealm,
	FoundRealmError,
	NewProposal,
	ProposalDeps,
	ProposalRef,
	ProposalRow,
	ProposeError,
	RejectError,
} from './realm.types.ts';

// Proposals are part of the realm service: approving founds a realm with the same writes as
// founding directly, so foundIn and the module rules live here and realm.service.ts uses them.

const MODULES = new Set<number>(Object.values(RealmModule));

/** The modules the code knows, each once, in the order given. */
export const knownModules = (modules: readonly number[]): RealmModule[] => [
	...new Set(modules.filter((module): module is RealmModule => MODULES.has(module))),
];

export const toProposal = ({
	proposerId,
	proposerName,
	proposerEmail,
	...row
}: ProposalRow): Proposal => ({
	...row,
	decidedAt: row.decidedAt && fromDate(row.decidedAt),
	createdAt: fromDate(row.createdAt),
	proposedBy: { id: proposerId, name: proposerName, email: proposerEmail },
});

export async function insertModules(
	tx: Tx,
	realmId: string,
	modules: readonly number[],
): Promise<void> {
	if (modules.length === 0) return;
	await tx.insert(realmModules).values(modules.map((module) => ({ realmId, module })));
}

/**
 * The writes that found a realm, in the caller's transaction: the realm, its modules, the founder
 * as admin, and both facts announced. A taken slug is a conflict and writes nothing.
 */
export async function foundIn(
	tx: Tx,
	founderId: string,
	realm: FoundRealm,
	now: Temporal.Instant,
): Promise<Result<string, FoundRealmError>> {
	const created = first(
		await tx
			.insert(realms)
			.values({
				slug: realm.slug,
				name: realm.name,
				description: realm.description ?? null,
				category: realm.category ?? null,
				createdBy: founderId,
			})
			.onConflictDoNothing()
			.returning({ id: realms.id }),
	);
	if (!created) {
		return err(new DuplicateSlug(`The slug "${realm.slug}" is taken.`));
	}
	await insertModules(tx, created.id, knownModules(realm.modules));
	await tx.insert(realmMembers).values({
		realmId: created.id,
		userId: founderId,
		role: RealmRole.admin,
	});
	await publish(
		tx,
		[
			realmEvents.created(created.id),
			realmEvents.memberChanged(created.id, founderId, RealmRole.admin),
		],
		now,
	);
	return ok(created.id);
}

/** How a proposal was decided. */
interface Verdict {
	status: ProposalStatus;
	decidedBy: string;
	note?: string;
	realmId?: string;
}

/**
 * Realms anyone may propose and a platform administrator approves or rejects. Part of the realm
 * service: approving founds the realm with the same writes as founding directly.
 */
export function createProposals(deps: ProposalDeps) {
	const { db, clock, seedCentroid } = deps;

	const select = (where: SQL | undefined) =>
		db
			.select({
				id: realmProposals.id,
				slug: realmProposals.slug,
				name: realmProposals.name,
				description: realmProposals.description,
				category: realmProposals.category,
				modules: realmProposals.modules,
				rationale: realmProposals.rationale,
				status: realmProposals.status,
				decisionNote: realmProposals.decisionNote,
				decidedAt: realmProposals.decidedAt,
				realmId: realmProposals.realmId,
				createdAt: realmProposals.createdAt,
				proposerId: user.id,
				proposerName: user.name,
				proposerEmail: user.email,
			})
			.from(realmProposals)
			.innerJoin(user, eq(user.id, realmProposals.proposedBy))
			.where(where);

	/** Only a pending proposal is decided; false otherwise. */
	async function decide(tx: Tx, id: string, verdict: Verdict): Promise<boolean> {
		const updated = await tx
			.update(realmProposals)
			.set({
				status: verdict.status,
				decidedBy: verdict.decidedBy,
				decidedAt: toDate(clock.now()),
				decisionNote: verdict.note ?? null,
				realmId: verdict.realmId ?? null,
			})
			.where(and(eq(realmProposals.id, id), eq(realmProposals.status, ProposalStatus.pending)))
			.returning({ id: realmProposals.id });
		return updated.length > 0;
	}

	return {
		async propose(proposal: NewProposal): Promise<Result<ProposalRef, ProposeError>> {
			const pending =
				(
					await db
						.select({ one: sql`1` })
						.from(realmProposals)
						.where(
							and(
								eq(realmProposals.proposedBy, proposal.proposedBy),
								eq(realmProposals.status, ProposalStatus.pending),
							),
						)
						.limit(1)
				).length > 0;
			if (pending) {
				return err(
					new DuplicateSlug(
						'You already have a proposal waiting. Wait for a decision on that one first.',
					),
				);
			}
			const taken =
				(
					await db
						.select({ one: sql`1` })
						.from(realms)
						.where(eq(realms.slug, proposal.slug))
						.limit(1)
				).length > 0;
			if (taken) {
				return err(new DuplicateSlug(`The name "${proposal.slug}" is already taken.`));
			}
			const created = one(
				await db
					.insert(realmProposals)
					.values({ ...proposal, modules: [...proposal.modules] })
					.returning({ id: realmProposals.id }),
				'proposal insert',
			);
			return ok({ id: created.id });
		},

		async myProposals(userId: string): Promise<Proposal[]> {
			const rows = await select(eq(realmProposals.proposedBy, userId))
				.orderBy(desc(realmProposals.createdAt))
				.limit(policy.pageSize);
			return rows.map(toProposal);
		},

		async pendingProposals(): Promise<Proposal[]> {
			const rows = await select(eq(realmProposals.status, ProposalStatus.pending))
				.orderBy(asc(realmProposals.createdAt))
				.limit(policy.pageSize);
			return rows.map(toProposal);
		},

		/**
		 * Founds the proposed realm with the proposer as its admin, and decides the proposal, in one
		 * transaction: a crash between the two can't leave a realm whose proposal is still pending.
		 */
		async approve(
			proposalId: string,
			actorId: string,
		): Promise<Result<ApprovedRealm, ApproveError>> {
			const approved = await inTransaction(db, async (tx) => {
				// Locked, so a second approval waits for this one and then finds it decided.
				const proposal = first(
					await tx
						.select({
							status: realmProposals.status,
							proposedBy: realmProposals.proposedBy,
							slug: realmProposals.slug,
							name: realmProposals.name,
							description: realmProposals.description,
							category: realmProposals.category,
							modules: realmProposals.modules,
						})
						.from(realmProposals)
						.where(eq(realmProposals.id, proposalId))
						.for('update'),
				);
				if (!proposal) return err(new RealmNotFound('No such proposal.'));
				if (proposal.status !== ProposalStatus.pending) {
					return err(new DuplicateSlug('That proposal has already been decided.'));
				}

				const founded = await foundIn(tx, proposal.proposedBy, proposal, clock.now());
				if (!founded.ok) return founded;
				const realmId = founded.value;

				// Locked above, so this holds; if it ever doesn't, the err rolls the realm back with it.
				const decided = await decide(tx, proposalId, {
					status: ProposalStatus.approved,
					decidedBy: actorId,
					realmId,
				});
				if (!decided) {
					return err(new DuplicateSlug('That proposal has already been decided.'));
				}
				await audit(tx, {
					actorId,
					entityType: 'realm_proposal',
					entityId: proposalId,
					action: AuditAction.updated,
					changes: { approved: true, slug: proposal.slug, realmId },
				});
				return ok({ realmId, name: proposal.name, description: proposal.description });
			});
			if (!approved.ok) return approved;

			const { realmId, name, description } = approved.value;
			// After the commit: the model call is slow, optional, and no reason to hold a transaction.
			await seedCentroid(realmId, name, description);
			return ok({ realmId });
		},

		reject(
			proposalId: string,
			actorId: string,
			note: string,
		): Promise<Result<ProposalRef, RejectError>> {
			return inTransaction(db, async (tx) => {
				if (
					!(await decide(tx, proposalId, {
						status: ProposalStatus.rejected,
						decidedBy: actorId,
						note,
					}))
				) {
					return err(
						new RealmNotFound(
							'No proposal waiting under that id. It may already have been decided.',
						),
					);
				}
				await audit(tx, {
					actorId,
					entityType: 'realm_proposal',
					entityId: proposalId,
					action: AuditAction.updated,
					changes: { approved: false, note },
				});
				return ok({ id: proposalId });
			});
		},
	};
}
