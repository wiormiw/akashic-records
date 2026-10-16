import { and, asc, desc, eq, or, type SQL, sql } from 'drizzle-orm';
import { type Member, type RealmEdit, realmEvents, type RealmSummary } from '@akashic/contracts';
import {
	audit,
	type Executor,
	inTransaction,
	publish,
	realmMembers,
	realmModules,
	realms,
	user,
} from '@akashic/db';
import { pgVector } from '@akashic/db/sql';
import { AuditAction, narrow, RealmRole } from '@akashic/lib/enums';
import { ErrorCode, fail } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import { policy } from '@/config.ts';
import {
	createProposals,
	foundIn,
	insertModules,
	knownModules,
} from './realm.proposals.service.ts';
import type {
	Actor,
	Archived,
	Edited,
	FoundedRealm,
	FoundRealm,
	Joined,
	Left,
	RealmDeps,
	RoleChange,
} from './realm.types.ts';

type SummaryRow = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	category: string | null;
	member_count: number;
	modules: number[] | null;
};

const toSummary = (row: SummaryRow): RealmSummary => ({
	id: row.id,
	slug: row.slug,
	name: row.name,
	description: row.description,
	category: row.category,
	memberCount: Number(row.member_count),
	modules: row.modules ?? [],
});

/** Live realms with their member counts and modules; `rest` filters further, orders and limits. */
export async function liveSummaries(db: Executor, rest: SQL): Promise<RealmSummary[]> {
	const rows = (await db.execute(sql`
    SELECT
      r.id, r.slug, r.name, r.description, r.category,
      (SELECT count(*)::int FROM realm_member m WHERE m.realm_id = r.id) AS member_count,
      (SELECT coalesce(array_agg(rm.module ORDER BY rm.module), '{}')
         FROM realm_module rm WHERE rm.realm_id = r.id) AS modules
    FROM realm r
    WHERE r.archived_at IS NULL
    ${rest}
  `)) as unknown as SummaryRow[];
	return rows.map(toSummary);
}

export const ofMember = (realmId: string, userId: string) =>
	and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId));

/** Whether `actor` ranks above `target`. Someone not in the realm outranks nobody. */
export const outranks = (actor: RealmRole | null, target: RealmRole): boolean =>
	actor !== null && actor > target;

/**
 * Whether `actor` may hand out `role`: an admin any role, anyone else only a role below their own
 * and below moderator (staff roles are an admin's to give).
 */
export const grantable = (actor: RealmRole | null, role: RealmRole): boolean =>
	actor === RealmRole.admin || (actor !== null && role < actor && role < RealmRole.moderator);

/** The rank someone acts with in a realm: a platform admin counts as its admin, member or not. */
export const actingRank = (platform: boolean, role: RealmRole | null): RealmRole | null =>
	platform ? RealmRole.admin : role;

/**
 * Whether `actor` may change the role of someone holding `target`: an admin anyone's, a fellow
 * admin's included; anyone else only someone below them.
 */
export const mayChange = (actor: RealmRole | null, target: RealmRole): boolean =>
	actor === RealmRole.admin || outranks(actor, target);

export function createRealmService(deps: RealmDeps) {
	const { db, embedder, clock } = deps;

	/** Seeds the centroid from the realm's own description, so fit can be judged from day one. */
	async function seedCentroid(
		realmId: string,
		name: string,
		description: string | null | undefined,
	): Promise<boolean> {
		const embedding = await embedder.embed([name, description].filter(Boolean).join('\n\n'));
		if (!embedding) return false;
		await db
			.update(realms)
			.set({
				centroid: sql`${pgVector(embedding)}::vector`,
				centroidSamples: sql`${realms.centroidSamples} + 1`,
				updatedAt: toDate(clock.now()),
			})
			.where(eq(realms.id, realmId));
		return true;
	}

	async function found(founderId: string, realm: FoundRealm): Promise<Result<FoundedRealm>> {
		const id = await inTransaction(db, (tx) => foundIn(tx, founderId, realm, clock.now()));
		if (!id.ok) return id;
		// After the commit: the model call is slow, optional, and no reason to hold a transaction.
		await seedCentroid(id.value, realm.name, realm.description);
		return ok({ id: id.value, slug: realm.slug });
	}

	return {
		seedCentroid,

		async browse(): Promise<RealmSummary[]> {
			return liveSummaries(
				db,
				sql`ORDER BY member_count DESC, r.created_at ASC LIMIT ${policy.pageSize}`,
			);
		},

		/** Live realms only. */
		async read(slug: string): Promise<Result<RealmSummary>> {
			const [realm] = await liveSummaries(db, sql`AND r.slug = ${slug} LIMIT 1`);
			return realm
				? ok(realm)
				: err(fail.notFound(ErrorCode.realm.notFound, `No realm called "${slug}".`));
		},

		found,

		join(realmId: string, userId: string): Promise<Result<Joined>> {
			return inTransaction(db, async (tx) => {
				// A second join, even one racing this, finds the row and inserts nothing.
				const inserted = await tx
					.insert(realmMembers)
					.values({ realmId, userId, role: RealmRole.member })
					.onConflictDoNothing()
					.returning({ userId: realmMembers.userId });
				if (inserted.length === 0) {
					return err(
						fail.conflict(ErrorCode.realm.alreadyMember, 'You are already in this realm.'),
					);
				}
				await publish(
					tx,
					[realmEvents.memberChanged(realmId, userId, RealmRole.member)],
					clock.now(),
				);
				return ok({ joined: true as const });
			});
		},

		leave(realmId: string, userId: string, role: RealmRole | null): Promise<Result<Left>> {
			return inTransaction(db, async (tx) => {
				if (role === RealmRole.admin) {
					// Locked, so two admins leaving at once can't both see the other still there.
					const admins = await tx
						.select({ userId: realmMembers.userId })
						.from(realmMembers)
						.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.role, RealmRole.admin)))
						.for('update');
					if (admins.length === 1) {
						return err(
							fail.conflict(
								ErrorCode.realm.soleAdmin,
								'You are the only admin. Promote someone else before leaving.',
							),
						);
					}
				}
				const removed = await tx
					.delete(realmMembers)
					.where(ofMember(realmId, userId))
					.returning({ userId: realmMembers.userId });
				if (removed.length === 0) {
					return err(fail.notFound(ErrorCode.realm.notMember, 'You are not in this realm.'));
				}
				await publish(tx, [realmEvents.memberChanged(realmId, userId, null)], clock.now());
				return ok({ left: true as const });
			});
		},

		/** The role `userId` holds in the realm now, or null when they aren't in it. */
		async memberRole(realmId: string, userId: string): Promise<RealmRole | null> {
			const [row] = await db
				.select({ role: realmMembers.role })
				.from(realmMembers)
				.where(ofMember(realmId, userId));
			return row ? narrow(RealmRole, row.role) : null;
		},

		async roster(realmId: string): Promise<Member[]> {
			const rows = await db
				.select({
					userId: realmMembers.userId,
					role: realmMembers.role,
					displayName: realmMembers.displayName,
					name: user.name,
					image: user.image,
					joinedAt: realmMembers.joinedAt,
				})
				.from(realmMembers)
				.innerJoin(user, eq(user.id, realmMembers.userId))
				.where(eq(realmMembers.realmId, realmId))
				// The user id breaks ties, so people who joined in the same instant keep one order.
				.orderBy(desc(realmMembers.role), asc(realmMembers.joinedAt), asc(realmMembers.userId))
				.limit(policy.pageSize);
			return rows.map((row) => ({ ...row, joinedAt: fromDate(row.joinedAt) }));
		},

		changeRole(
			realmId: string,
			actor: Actor,
			targetId: string,
			role: RealmRole,
		): Promise<Result<RoleChange>> {
			if (targetId === actor.id) {
				return Promise.resolve(
					err(fail.forbidden(ErrorCode.realm.forbidden, 'You cannot change your own role.')),
				);
			}
			return inTransaction(db, async (tx) => {
				// One statement locks the actor, the target and every admin, in user id order, so two
				// changes racing each other queue rather than deadlock. Rank and admin count are read
				// under the lock: two admins demoting each other at once can't leave the realm with none.
				const locked = await tx
					.select({ userId: realmMembers.userId, role: realmMembers.role })
					.from(realmMembers)
					.where(
						and(
							eq(realmMembers.realmId, realmId),
							or(
								eq(realmMembers.userId, actor.id),
								eq(realmMembers.userId, targetId),
								eq(realmMembers.role, RealmRole.admin),
							),
						),
					)
					.orderBy(asc(realmMembers.userId))
					.for('update');
				const roleIn = (userId: string) => {
					const row = locked.find((r) => r.userId === userId);
					return row ? narrow(RealmRole, row.role) : null;
				};
				const rank = actingRank(actor.platform, roleIn(actor.id));
				// Vouching makes someone verified; only an admin hands out staff roles. Below admin,
				// nobody grants a role as high as their own.
				if (!grantable(rank, role)) {
					return err(
						fail.forbidden(
							ErrorCode.realm.forbidden,
							role >= RealmRole.moderator
								? 'Only an admin can grant moderator or admin.'
								: 'You can only grant a role below your own.',
						),
					);
				}
				const current = roleIn(targetId);
				if (current === null) {
					return err(fail.notFound(ErrorCode.realm.notMember, 'That person is not in this realm.'));
				}
				// An admin changes anyone's role, a fellow admin's too; below admin, only someone beneath
				// you (a moderator can't demote a fellow moderator: a recall exists for that).
				if (!mayChange(rank, current)) {
					return err(
						fail.forbidden(
							ErrorCode.realm.forbidden,
							'You can only change the role of someone below you.',
						),
					);
				}
				if (current === RealmRole.admin && role < RealmRole.admin) {
					const admins = locked.filter((r) => r.role === RealmRole.admin).length;
					if (admins <= 1) {
						return err(
							fail.conflict(
								ErrorCode.realm.soleAdmin,
								"This is the realm's only admin. Promote someone else first.",
							),
						);
					}
				}
				await tx.update(realmMembers).set({ role }).where(ofMember(realmId, targetId));
				await publish(tx, [realmEvents.memberChanged(realmId, targetId, role)], clock.now());
				await audit(tx, {
					actorId: actor.id,
					entityType: 'realm_member',
					entityId: targetId,
					action: AuditAction.roleChanged,
					changes: { realmId, role },
				});
				return ok({ userId: targetId, role });
			});
		},

		async edit(realmId: string, actorId: string, edit: RealmEdit): Promise<Result<Edited>> {
			const { modules, ...values } = edit;
			const changed = Object.keys(edit).filter((key) => edit[key as keyof RealmEdit] !== undefined);
			if (changed.length === 0) return ok({ changed });

			return inTransaction(db, async (tx) => {
				const updated = await tx
					.update(realms)
					.set({ ...values, updatedAt: toDate(clock.now()) })
					.where(eq(realms.id, realmId))
					.returning({ id: realms.id });
				if (updated.length === 0) {
					return err(fail.notFound(ErrorCode.realm.notFound, 'No such realm.'));
				}
				if (modules) {
					await tx.delete(realmModules).where(eq(realmModules.realmId, realmId));
					await insertModules(tx, realmId, knownModules(modules));
				}
				await audit(tx, {
					actorId,
					entityType: 'realm',
					entityId: realmId,
					action: AuditAction.updated,
					changes: Object.fromEntries(changed.map((key) => [key, edit[key as keyof RealmEdit]])),
				});
				return ok({ changed });
			});
		},

		archive(realmId: string, actorId: string, archived: boolean): Promise<Result<Archived>> {
			const now = clock.now();
			return inTransaction(db, async (tx) => {
				const updated = await tx
					.update(realms)
					.set({ archivedAt: archived ? toDate(now) : null, updatedAt: toDate(now) })
					.where(eq(realms.id, realmId))
					.returning({ id: realms.id });
				if (updated.length === 0) {
					return err(fail.notFound(ErrorCode.realm.notFound, 'No such realm.'));
				}
				await audit(tx, {
					actorId,
					entityType: 'realm',
					entityId: realmId,
					action: archived ? AuditAction.deleted : AuditAction.updated,
					changes: { archived },
				});
				return ok({ archived });
			});
		},

		...createProposals({ db, clock, seedCentroid }),
	};
}

export type RealmService = ReturnType<typeof createRealmService>;
