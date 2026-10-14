import { and, eq } from "drizzle-orm";
import * as v from "valibot";
import { realmMembers, type Tx } from "@akashic/db";
import { narrow, RealmRole } from "@akashic/lib/enums";
import type { Embedder } from "@/integrations/embedder.ts";
import { createRealmService } from "@/modules/realm/realm.service.ts";
import { clock, outbox, person, uniqueSlug } from "../../support/fixtures.ts";

export const noEmbedder: Embedder = { available: false, embed: async () => null };

/** The realm service on `tx`, and the helpers the scenarios share. */
export function world(tx: Tx, embedder: Embedder = noEmbedder) {
  const realms = createRealmService({ db: tx, embedder, clock });
  return {
    realms,
    person: (name?: string) => person(tx, name),

    /** A realm founded by a fresh admin, with `members` more people in it. */
    async realm(modules: number[] = [], members = 0) {
      const admin = await person(tx, "Founder");
      const slug = uniqueSlug();
      const founded = await realms.found(admin, { slug, name: "Test realm", modules });
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

// The web app's schemas (akashic_records_fe/src/lib/api/{realms,proposals}.ts), copied: every
// response must parse with what the browser parses it with.
export const Web = {
  RealmSummary: v.object({
    id: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.nullable(v.string()),
    category: v.nullable(v.string()),
    memberCount: v.number(),
    modules: v.array(v.number()),
  }),
  Standing: v.object({
    role: v.nullable(v.number()),
    permissions: v.array(v.string()),
  }),
  Member: v.object({
    userId: v.string(),
    name: v.string(),
    displayName: v.nullable(v.string()),
    image: v.nullable(v.string()),
    role: v.number(),
    joinedAt: v.string(),
  }),
  Proposal: v.object({
    id: v.string(),
    slug: v.string(),
    name: v.string(),
    description: v.nullable(v.string()),
    category: v.nullable(v.string()),
    modules: v.array(v.number()),
    rationale: v.string(),
    proposedBy: v.nullable(v.object({ id: v.string(), name: v.string(), email: v.string() })),
    status: v.number(),
    decisionNote: v.nullable(v.string()),
    decidedAt: v.nullable(v.string()),
    realmId: v.nullable(v.string()),
    createdAt: v.string(),
  }),
};
