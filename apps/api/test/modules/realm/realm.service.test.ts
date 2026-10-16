import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditEntries, createDb, realmModules, realms as realmTable, type Tx } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { AuditAction, RealmModule, RealmRole } from '@akashic/lib/enums';
import { ErrorCode } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { expectErr, expectOk } from '@akashic/lib/testing';
import type { Embedder } from '@/integrations/embedder.ts';
import { actingRank, grantable, mayChange, outranks } from '@/modules/realm/realm.service.ts';
import { databaseUrl, uniqueSlug } from '../../support/fixtures.ts';
import { world } from './fixtures.ts';

describe('role rules', () => {
	test('only a higher rank outranks; someone outside the realm outranks nobody', () => {
		expect(outranks(RealmRole.admin, RealmRole.moderator)).toBe(true);
		expect(outranks(RealmRole.moderator, RealmRole.moderator)).toBe(false);
		expect(outranks(RealmRole.moderator, RealmRole.admin)).toBe(false);
		expect(outranks(null, RealmRole.member)).toBe(false);
	});

	test('an admin grants any role; anyone else only below their own and below moderator', () => {
		expect(grantable(RealmRole.admin, RealmRole.admin)).toBe(true);
		expect(grantable(RealmRole.moderator, RealmRole.verified)).toBe(true);
		expect(grantable(RealmRole.moderator, RealmRole.moderator)).toBe(false);
		expect(grantable(RealmRole.verified, RealmRole.verified)).toBe(false);
		expect(grantable(RealmRole.verified, RealmRole.member)).toBe(true);
		expect(grantable(null, RealmRole.member)).toBe(false);
	});

	test("an admin changes a fellow admin's role; below admin, only someone beneath you", () => {
		expect(mayChange(RealmRole.admin, RealmRole.admin)).toBe(true);
		expect(mayChange(RealmRole.moderator, RealmRole.moderator)).toBe(false);
		expect(mayChange(RealmRole.moderator, RealmRole.verified)).toBe(true);
		expect(mayChange(null, RealmRole.member)).toBe(false);
	});

	test('a platform admin acts as an admin, member or not', () => {
		expect(actingRank(true, null)).toBe(RealmRole.admin);
		expect(actingRank(true, RealmRole.member)).toBe(RealmRole.admin);
		expect(actingRank(false, RealmRole.moderator)).toBe(RealmRole.moderator);
		expect(actingRank(false, null)).toBeNull();
	});
});

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

const auditsOf = (tx: Tx, entityId: string) =>
	tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId));

describe.skipIf(!live)('realms', () => {
	test('founding makes the founder admin and announces both facts', () =>
		inWorld(async (w) => {
			const { id, slug, admin } = await w.realm([RealmModule.events, RealmModule.jobs]);
			expect(await w.roleOf(id, admin)).toBe(RealmRole.admin);
			expect((await w.outbox('realm.member_changed', id)).map((row) => row.payload)).toEqual([
				{ realmId: id, userId: admin, role: RealmRole.admin },
			]);
			expect(await w.outbox('realm.created', id)).toHaveLength(1);
			expect(expectOk(await w.realms.read(slug))).toMatchObject({
				id,
				memberCount: 1,
				modules: [RealmModule.jobs, RealmModule.events],
			});
		}));

	test('memberRole reads the row as it is now: the role, or null once gone', () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm([], 1);
			const [member] = people as [string];
			expect(await w.realms.memberRole(id, admin)).toBe(RealmRole.admin);
			expect(await w.realms.memberRole(id, member)).toBe(RealmRole.member);
			expectOk(await w.realms.leave(id, member, RealmRole.member));
			expect(await w.realms.memberRole(id, member)).toBeNull();
		}));

	test('a taken slug is a conflict, and writes nothing', () =>
		inWorld(async (w) => {
			const founder = await w.person();
			const slug = uniqueSlug();
			expectOk(await w.realms.found(founder, { slug, name: 'One', modules: [] }));
			expectErr(
				await w.realms.found(founder, { slug, name: 'Two', modules: [] }),
				ErrorCode.realm.duplicateSlug,
			);
		}));

	test('unknown and repeated modules are dropped', () =>
		inWorld(async (w, tx) => {
			const founder = await w.person();
			const { id } = expectOk(
				await w.realms.found(founder, {
					slug: uniqueSlug(),
					name: 'Modules',
					modules: [RealmModule.market, 99, RealmModule.market],
				}),
			);
			const rows = await tx.select().from(realmModules).where(eq(realmModules.realmId, id));
			expect(rows.map((row) => row.module)).toEqual([RealmModule.market]);
		}));

	test('founding seeds the centroid when a model answers', () =>
		inWorld(
			async (w, tx) => {
				const { id } = await w.realm();
				const [row] = await tx
					.select({ samples: realmTable.centroidSamples })
					.from(realmTable)
					.where(eq(realmTable.id, id));
				expect(row?.samples).toBe(1);
			},
			{ available: true, embed: async () => Array.from({ length: 1536 }, () => 0.5) },
		));

	test('an archived realm is not read, and not listed', () =>
		inWorld(async (w) => {
			const { id, slug, admin } = await w.realm();
			expect(expectOk(await w.realms.archive(id, admin, true))).toEqual({ archived: true });
			expectErr(await w.realms.read(slug), ErrorCode.realm.notFound);
			expect((await w.realms.browse()).some((realm) => realm.id === id)).toBe(false);
			expectOk(await w.realms.archive(id, admin, false));
			expect(expectOk(await w.realms.read(slug)).id).toBe(id);
		}));

	test('joining twice is a conflict, and announces once', () =>
		inWorld(async (w) => {
			const { id } = await w.realm();
			const member = await w.person();
			expect(expectOk(await w.realms.join(id, member))).toEqual({ joined: true });
			expectErr(await w.realms.join(id, member), ErrorCode.realm.alreadyMember);
			const changes = (await w.outbox('realm.member_changed', id)).filter(
				(row) => (row.payload as { userId: string }).userId === member,
			);
			expect(changes).toHaveLength(1);
		}));

	test("leaving announces the departure; a stranger can't leave", () =>
		inWorld(async (w) => {
			const { id, people } = await w.realm([], 1);
			const [member] = people as [string];
			expect(expectOk(await w.realms.leave(id, member, RealmRole.member))).toEqual({ left: true });
			expect(await w.roleOf(id, member)).toBeNull();
			expect((await w.outbox('realm.member_changed', id)).map((row) => row.payload)).toContainEqual(
				{ realmId: id, userId: member, role: null },
			);
			expectErr(await w.realms.leave(id, member, null), ErrorCode.realm.notMember);
		}));

	test("the only admin can't leave; one of two can", () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm([], 1);
			expectErr(await w.realms.leave(id, admin, RealmRole.admin), ErrorCode.realm.soleAdmin);
			const [other] = people as [string];
			expectOk(
				await w.realms.changeRole(id, { id: admin, platform: false }, other, RealmRole.admin),
			);
			expectOk(await w.realms.leave(id, admin, RealmRole.admin));
		}));

	test('the roster lists staff first, with their names', () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm([], 2);
			const roster = await w.realms.roster(id);
			expect(roster.map((m) => m.userId)).toEqual([admin, ...people]);
			expect(roster[0]).toMatchObject({
				role: RealmRole.admin,
				name: 'Founder',
				displayName: null,
			});
		}));

	test('an edit changes what was given, and records it', () =>
		inWorld(async (w, tx) => {
			const { id, slug, admin } = await w.realm([RealmModule.jobs]);
			expect(expectOk(await w.realms.edit(id, admin, {}))).toEqual({ changed: [] });
			expect(
				expectOk(
					await w.realms.edit(id, admin, {
						name: 'Renamed',
						category: null,
						modules: [RealmModule.events],
					}),
				),
			).toEqual({ changed: ['name', 'category', 'modules'] });
			expect(expectOk(await w.realms.read(slug))).toMatchObject({
				name: 'Renamed',
				category: null,
				modules: [RealmModule.events],
			});
			expect(await auditsOf(tx, id)).toEqual([
				expect.objectContaining({
					userId: admin,
					action: AuditAction.updated,
					changes: { name: 'Renamed', category: null, modules: [RealmModule.events] },
				}),
			]);
		}));

	test('archiving is recorded as a deletion, restoring as an update', () =>
		inWorld(async (w, tx) => {
			const { id, admin } = await w.realm();
			expectOk(await w.realms.archive(id, admin, true));
			expectOk(await w.realms.archive(id, admin, false));
			expect((await auditsOf(tx, id)).map((row) => row.action).sort()).toEqual(
				[AuditAction.updated, AuditAction.deleted].sort(),
			);
		}));
});

describe.skipIf(!live)('roles', () => {
	test('staff roles need an admin, anyone staff can vouch, and nobody changes their own', () =>
		inWorld(async (w, tx) => {
			const { id, admin, people } = await w.realm([], 2);
			const [mod, member] = people as [string, string];
			const asAdmin = { id: admin, platform: false };

			expectOk(await w.realms.changeRole(id, asAdmin, mod, RealmRole.moderator));
			expect(await w.roleOf(id, mod)).toBe(RealmRole.moderator);
			expect(await auditsOf(tx, mod)).toEqual([
				expect.objectContaining({
					userId: admin,
					entityType: 'realm_member',
					action: AuditAction.roleChanged,
					changes: { realmId: id, role: RealmRole.moderator },
				}),
			]);

			const asMod = { id: mod, platform: false };
			expectErr(
				await w.realms.changeRole(id, asMod, member, RealmRole.moderator),
				ErrorCode.realm.forbidden,
			);
			expectOk(await w.realms.changeRole(id, asMod, member, RealmRole.verified));
			expect(await w.roleOf(id, member)).toBe(RealmRole.verified);
			expect((await w.outbox('realm.member_changed', id)).map((row) => row.payload)).toContainEqual(
				{ realmId: id, userId: member, role: RealmRole.verified },
			);

			expectErr(
				await w.realms.changeRole(id, asAdmin, admin, RealmRole.member),
				ErrorCode.realm.forbidden,
			);
			expectErr(
				await w.realms.changeRole(id, asAdmin, Bun.randomUUIDv7(), RealmRole.verified),
				ErrorCode.realm.notMember,
			);
		}));

	test("a moderator can't demote an admin or a fellow moderator; an admin can demote a moderator", () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm([], 3);
			const [mod, peer, member] = people as [string, string, string];
			const asAdmin = { id: admin, platform: false };
			expectOk(await w.realms.changeRole(id, asAdmin, mod, RealmRole.moderator));
			expectOk(await w.realms.changeRole(id, asAdmin, peer, RealmRole.moderator));
			expectOk(await w.realms.changeRole(id, asAdmin, member, RealmRole.verified));

			const asMod = { id: mod, platform: false };
			expectErr(
				await w.realms.changeRole(id, asMod, admin, RealmRole.member),
				ErrorCode.realm.forbidden,
			);
			expectErr(
				await w.realms.changeRole(id, asMod, peer, RealmRole.member),
				ErrorCode.realm.forbidden,
			);
			expect(await w.roleOf(id, admin)).toBe(RealmRole.admin);
			expect(await w.roleOf(id, peer)).toBe(RealmRole.moderator);
			// Below them is still theirs to change.
			expectOk(await w.realms.changeRole(id, asMod, member, RealmRole.member));

			expectOk(await w.realms.changeRole(id, asAdmin, peer, RealmRole.member));
			expect(await w.roleOf(id, peer)).toBe(RealmRole.member);

			// Someone verified can't hand out verified: only a role below their own.
			const asVerified = { id: member, platform: false };
			expectErr(
				await w.realms.changeRole(id, asVerified, peer, RealmRole.verified),
				ErrorCode.realm.forbidden,
			);
		}));

	test("the sole admin can't be demoted, so a realm never ends up without one", () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm([], 1);
			const [mod] = people as [string];
			expectOk(
				await w.realms.changeRole(id, { id: admin, platform: false }, mod, RealmRole.moderator),
			);
			for (const role of [RealmRole.member, RealmRole.verified, RealmRole.moderator]) {
				expectErr(
					await w.realms.changeRole(id, { id: mod, platform: false }, admin, role),
					ErrorCode.realm.forbidden,
				);
			}
			expectErr(
				await w.realms.changeRole(id, { id: admin, platform: false }, admin, RealmRole.member),
				ErrorCode.realm.forbidden,
			);
			expect(await w.roleOf(id, admin)).toBe(RealmRole.admin);

			// Platform authority outranks the realm's admin, but doesn't leave the realm without one.
			const platform = await w.person('Platform admin');
			expectErr(
				await w.realms.changeRole(id, { id: platform, platform: true }, admin, RealmRole.member),
				ErrorCode.realm.soleAdmin,
			);
			expect(await w.roleOf(id, admin)).toBe(RealmRole.admin);
		}));

	test('an admin demotes a fellow admin', () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm([], 1);
			const [peer] = people as [string];
			const asAdmin = { id: admin, platform: false };
			expectOk(await w.realms.changeRole(id, asAdmin, peer, RealmRole.admin));
			expectOk(await w.realms.changeRole(id, asAdmin, peer, RealmRole.moderator));
			expect(await w.roleOf(id, peer)).toBe(RealmRole.moderator);
			// The demoted admin no longer acts as one: their role is read under the lock.
			expectErr(
				await w.realms.changeRole(id, { id: peer, platform: false }, admin, RealmRole.member),
				ErrorCode.realm.forbidden,
			);
		}));

	test("a platform admin who isn't a member changes any role, an admin's included", () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm([], 2);
			const [member, peer] = people as [string, string];
			const asPlatform = { id: await w.person('Platform admin'), platform: true };
			expectOk(await w.realms.changeRole(id, asPlatform, member, RealmRole.moderator));
			expectOk(await w.realms.changeRole(id, asPlatform, peer, RealmRole.admin));
			expectOk(await w.realms.changeRole(id, asPlatform, admin, RealmRole.verified));
			expect(await w.roleOf(id, admin)).toBe(RealmRole.verified);
			expect((await w.outbox('realm.member_changed', id)).map((row) => row.payload)).toContainEqual(
				{ realmId: id, userId: admin, role: RealmRole.verified },
			);
		}));
});
