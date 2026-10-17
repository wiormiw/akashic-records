import { and, eq } from 'drizzle-orm';
import { realmMembers, type Tx } from '@akashic/db';
import { narrow, RealmRole } from '@akashic/lib/enums';
import type { Embedder } from '@/integrations/embedder.ts';
import { createRealmService } from '@/modules/realm/realm.service.ts';
import { clock, outbox, person, uniqueSlug } from '../../support/fixtures.ts';

export const noEmbedder: Embedder = { available: false, embed: async () => null };

/** The realm service on `tx`, and the helpers the scenarios share. */
export function world(tx: Tx, embedder: Embedder = noEmbedder) {
	const realms = createRealmService({ db: tx, embedder, clock });
	return {
		realms,
		person: (name?: string) => person(tx, name),

		/** A realm founded by a fresh admin, with `members` more people in it. */
		async realm(modules: number[] = [], members = 0) {
			const admin = await person(tx, 'Founder');
			const slug = uniqueSlug();
			const founded = await realms.found(admin, { slug, name: 'Test realm', modules });
			if (!founded.ok) throw founded.error;
			const people: string[] = [];
			for (let i = 0; i < members; i++) {
				const member = await person(tx, `Member ${i}`);
				const joined = await realms.join(founded.value.id, member);
				if (!joined.ok) throw joined.error;
				people.push(member);
			}
			return { id: founded.value.id, slug, admin, people };
		},

		async roleOf(realmId: string, userId: string): Promise<RealmRole | null> {
			const [row] = await tx
				.select({ role: realmMembers.role })
				.from(realmMembers)
				.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)));
			return row ? narrow(RealmRole, row.role) : null;
		},

		outbox: (type: string, realmId: string) => outbox(tx, type, realmId),
	};
}
