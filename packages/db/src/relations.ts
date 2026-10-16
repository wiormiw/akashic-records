import { defineRelations } from 'drizzle-orm';
import * as schema from './schema/index.ts';

// Relations the relational query API (`db.query.*`) follows. Modules add theirs as they need
// them; each `many` needs the `one` on the other side.
export const relations = defineRelations(schema, (r) => ({
	realms: {
		members: r.many.realmMembers(),
		modules: r.many.realmModules(),
	},
	realmMembers: {
		realm: r.one.realms({ from: r.realmMembers.realmId, to: r.realms.id }),
		user: r.one.user({ from: r.realmMembers.userId, to: r.user.id }),
	},
	realmModules: {
		realm: r.one.realms({ from: r.realmModules.realmId, to: r.realms.id }),
	},
}));
