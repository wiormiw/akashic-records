import type { Proposal } from "@akashic/contracts";
import { parseVector } from "@akashic/db/sql";
import { RealmModule } from "@akashic/lib/enums";
import { fromDate } from "@akashic/lib/time";

// What the realm queries decide about the rows they read. Pure, so tested without a database.

const MODULES = new Set<number>(Object.values(RealmModule));

/** The modules the code knows, each once, in the order given. */
export const knownModules = (modules: readonly number[]): RealmModule[] => [
  ...new Set(modules.filter((module): module is RealmModule => MODULES.has(module))),
];

/** The stored centroid, read as text, as numbers; a realm with none has learned from nothing. */
export const centroidFrom = (
  row: { centroid: string | null; samples: number | null } | undefined,
): { centroid: number[] | null; samples: number } => ({
  centroid: row?.centroid ? parseVector(row.centroid) : null,
  samples: row?.samples ?? 0,
});

/** One proposal row, joined to its proposer (who may have deleted their account). */
export interface ProposalRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  modules: number[];
  rationale: string;
  status: number;
  decisionNote: string | null;
  decidedAt: Date | null;
  realmId: string | null;
  createdAt: Date;
  proposerId: string | null;
  proposerName: string | null;
  proposerEmail: string | null;
}

export const toProposal = ({
  proposerId,
  proposerName,
  proposerEmail,
  ...row
}: ProposalRow): Proposal => ({
  ...row,
  decidedAt: row.decidedAt && fromDate(row.decidedAt),
  createdAt: fromDate(row.createdAt),
  proposedBy: proposerId
    ? { id: proposerId, name: proposerName ?? "", email: proposerEmail ?? "" }
    : null,
});
