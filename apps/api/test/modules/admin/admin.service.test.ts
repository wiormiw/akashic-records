import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { realmEvents } from '@akashic/contracts';
import {
	auditEntries,
	createDb,
	realmMembers,
	roomReports,
	session,
	type Tx,
	user,
} from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { AuditAction, RealmRole } from '@akashic/lib/enums';
import { ErrorCode, RouteNotFound, ValidationFailed } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { isError } from '@akashic/lib/result';
import { expectErr, expectOk, expectType } from '@akashic/lib/testing';
import { databaseUrl, outbox } from '../../support/fixtures.ts';
import { world, type World } from './fixtures.ts';

// The admin service on the real database, each test in a transaction that is rolled back. The
// database holds real data: tests assert on the rows they create, or on a count's change.

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: World, tx: Tx) => Promise<void>) =>
	withRollback(database.db, (tx) => run(world(tx), tx));

const auditOf = (tx: Tx, entityId: string) =>
	tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId));

describe.skipIf(!live)('the overview and the listings', () => {
	test('the counts move with what is created', () =>
		inWorld(async (w) => {
			const before = await w.admin.overview();
			const orphan = await w.realm(0, 2);
			const staffed = await w.realm(1, 0);
			const reporter = await w.person();
			const accused = await w.person();
			await w.report(reporter, accused);
			const after = await w.admin.overview();

			// Two realms, and the one the report's room sits in.
			expect(after.realms - before.realms).toBe(3);
			expect(after.orphaned - before.orphaned).toBe(1);
			// Two orphan members, one admin, the reporter and the accused, and each realm's founder.
			expect(after.members - before.members).toBeGreaterThanOrEqual(5);
			expect(after.openReports - before.openReports).toBe(1);
			expect(orphan.id).not.toBe(staffed.id);
		}));

	test('realms list newest first with their member and admin counts and founder', () =>
		inWorld(async (w) => {
			const { slug, founder } = await w.realm(2, 3);
			const listed = (await w.admin.realms(200)).find((r) => r.slug === slug);
			expect(listed).toMatchObject({ memberCount: 5, adminCount: 2, archivedAt: null });
			expect(listed?.createdBy?.id).toBe(founder);
		}));

	test('accounts are searched by name or email, escaping wildcards', () =>
		inWorld(async (w) => {
			const target = await w.account('Zyxwv Quux');
			await w.account('Zyxwv Other');
			const byEmail = await w.admin.accounts(target.email, 50);
			expect(byEmail.map((a) => a.id)).toEqual([target.id]);
			expect((await w.admin.accounts('zyxwv quux', 50)).map((a) => a.id)).toEqual([target.id]);
			expect(await w.admin.accounts('100%_nobody-has-this', 50)).toEqual([]);
		}));

	test('the audit trail filters by entity type and names the actor', () =>
		inWorld(async (w, tx) => {
			const actor = await w.person();
			const target = await w.account();
			expectOk(await w.admin.setBan(target.id, actor, { banned: true, reason: 'Spam.' }));
			const entries = await w.admin.audit(200, 'user');
			const ours = entries.find((e) => e.entityId === target.id);
			expect(ours?.actor?.id).toBe(actor);
			expect(entries.every((e) => e.entityType === 'user')).toBe(true);
			expect((await auditOf(tx, target.id)).length).toBe(1);
		}));

	test('reports say whether the reported message came from the accused', () =>
		inWorld(async (w) => {
			const reporter = await w.person('Reporter');
			const accused = await w.person('Accused');
			const bystander = await w.person('Bystander');
			const honest = await w.report(reporter, accused);
			const wrong = await w.report(reporter, accused, bystander);
			const listed = await w.admin.reports(false, 200);
			expect(listed.find((r) => r.id === honest)).toMatchObject({
				senderMatches: true,
				reporter: { id: reporter },
				accused: { id: accused },
			});
			expect(listed.find((r) => r.id === wrong)?.senderMatches).toBe(false);
		}));
});

describe.skipIf(!live)('reviewing a report', () => {
	test('marks it reviewed and audits it; a second review finds nothing waiting', () =>
		inWorld(async (w, tx) => {
			const reporter = await w.person();
			const accused = await w.person();
			const id = await w.report(reporter, accused);
			const actor = await w.person();

			expect(expectOk(await w.admin.reviewReport(id, actor))).toEqual({ id });
			const [row] = await tx.select().from(roomReports).where(eq(roomReports.id, id));
			expect(row?.reviewedAt).not.toBeNull();
			expect(await auditOf(tx, id)).toMatchObject([
				{ entityType: 'room_report', action: AuditAction.moderated, userId: actor },
			]);

			expectErr(await w.admin.reviewReport(id, actor), ErrorCode.common.routeNotFound);
			expect(await auditOf(tx, id)).toHaveLength(1);
		}));
});

describe.skipIf(!live)('granting realm admin', () => {
	test('promotes a member, announces it and audits it, in one transaction', () =>
		inWorld(async (w, tx) => {
			const { id, slug, people } = await w.realm(1, 1);
			const member = people[1]!;
			const [account] = await tx.select().from(user).where(eq(user.id, member));
			const actor = await w.person();

			const granted = expectOk(await w.admin.grantRealmAdmin(slug, account!.email, actor));
			expect(granted).toEqual({ realmId: id, userId: member, name: account!.name });

			const [row] = await tx.select().from(realmMembers).where(eq(realmMembers.userId, member));
			expect(row?.role).toBe(RealmRole.admin);
			const events = await outbox(tx, 'realm.member_changed', id);
			expect(events.map((e) => e.payload)).toContainEqual(
				realmEvents.memberChanged(id, member, RealmRole.admin).payload,
			);
			expect(await auditOf(tx, id)).toMatchObject([
				{
					action: AuditAction.roleChanged,
					userId: actor,
					changes: { grantedAdminTo: account!.email, by: 'platform' },
				},
			]);
		}));

	test("joins someone who isn't a member yet, as admin", () =>
		inWorld(async (w, tx) => {
			const { id, slug } = await w.realm(0, 0);
			const outsider = await w.account();
			expectOk(await w.admin.grantRealmAdmin(slug, outsider.email, await w.person()));
			const [row] = await tx
				.select()
				.from(realmMembers)
				.where(eq(realmMembers.userId, outsider.id));
			expect(row).toMatchObject({ realmId: id, role: RealmRole.admin });
		}));

	test('an unknown realm or account is refused, and nothing is written', () =>
		inWorld(async (w, tx) => {
			const { id, slug } = await w.realm();
			const actor = await w.person();
			expectErr(
				await w.admin.grantRealmAdmin('no-such-realm-xyz', 'a@example.test', actor),
				ErrorCode.realm.notFound,
			);
			expectErr(
				await w.admin.grantRealmAdmin(slug, 'nobody@example.test', actor),
				ErrorCode.common.routeNotFound,
			);
			expect(await outbox(tx, 'realm.member_changed', id)).toEqual([]);
			expect(await auditOf(tx, actor)).toEqual([]);
		}));
});

describe.skipIf(!live)('suspensions', () => {
	const until = Temporal.Instant.from('2026-06-02T00:00:00Z');

	test('a suspension is stored with its reason and end, audited as moderation, and ends sessions', () =>
		inWorld(async (w, tx) => {
			const target = await w.account();
			await tx.insert(session).values({
				id: Bun.randomUUIDv7(),
				userId: target.id,
				token: Bun.randomUUIDv7(),
				expiresAt: new Date(Date.now() + 3_600_000),
			});
			const result = await w.admin.setBan(target.id, await w.person(), {
				banned: true,
				reason: 'Spam.',
				until,
			});
			expect(expectOk(result)).toEqual({ banned: true });

			const [row] = await tx.select().from(user).where(eq(user.id, target.id));
			expect(row).toMatchObject({ banReason: 'Spam.' });
			expect(row?.bannedAt).not.toBeNull();
			expect(row?.bannedUntil?.toISOString()).toBe('2026-06-02T00:00:00.000Z');
			expect(await tx.select().from(session).where(eq(session.userId, target.id))).toEqual([]);
			expect(await auditOf(tx, target.id)).toMatchObject([
				{
					entityType: 'user',
					action: AuditAction.moderated,
					changes: { banned: true, reason: 'Spam.', until: until.toString() },
				},
			]);
		}));

	test('lifting one clears it, and is audited as an update', () =>
		inWorld(async (w, tx) => {
			const target = await w.account();
			const actor = await w.person();
			expectOk(await w.admin.setBan(target.id, actor, { banned: true, reason: 'Spam.' }));
			expectOk(await w.admin.setBan(target.id, actor, { banned: false }));
			const [row] = await tx.select().from(user).where(eq(user.id, target.id));
			expect(row).toMatchObject({ bannedAt: null, banReason: null, bannedUntil: null });
			const entries = await auditOf(tx, target.id);
			expect(entries.map((e) => e.action).sort()).toEqual([
				AuditAction.updated,
				AuditAction.moderated,
			]);
		}));

	test('an unknown account, oneself, or no reason is refused, and nothing is audited', () =>
		inWorld(async (w, tx) => {
			const target = await w.account();
			const actor = await w.person();
			const ghost = Bun.randomUUIDv7();
			expectErr(
				await w.admin.setBan(ghost, actor, { banned: true, reason: 'x' }),
				ErrorCode.common.routeNotFound,
			);
			expectErr(
				await w.admin.setBan(actor, actor, { banned: true, reason: 'x' }),
				ErrorCode.common.validation,
			);
			expectErr(
				await w.admin.setBan(target.id, actor, { banned: true }),
				ErrorCode.common.validation,
			);
			for (const id of [ghost, actor, target.id]) expect(await auditOf(tx, id)).toEqual([]);
		}));
});

describe.skipIf(!live)('a refused suspension', () => {
	test('narrows to the one error, leaving the rest', () =>
		inWorld(async (w) => {
			const actor = await w.person();

			const ghost = await w.admin.setBan(Bun.randomUUIDv7(), actor, { banned: true, reason: 'x' });
			if (!isError(ghost, RouteNotFound)) throw new Error('expected RouteNotFound');
			expect(expectType<RouteNotFound>(ghost.error)).toBeInstanceOf(RouteNotFound);
			// @ts-expect-error the branch holds only RouteNotFound
			expectType<ValidationFailed>(ghost.error);

			const self = await w.admin.setBan(actor, actor, { banned: true, reason: 'x' });
			if (self.ok || isError(self, RouteNotFound)) throw new Error('expected ValidationFailed');
			// RouteNotFound is ruled out, so ValidationFailed is all that remains.
			expect(expectType<ValidationFailed>(self.error)).toBeInstanceOf(ValidationFailed);
			// @ts-expect-error RouteNotFound was narrowed away
			expectType<RouteNotFound>(self.error);
		}));
});
