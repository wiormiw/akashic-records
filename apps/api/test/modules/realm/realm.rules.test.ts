import { describe, expect, test } from "bun:test";
import { ProposalStatus, RealmModule } from "@akashic/lib/enums";
import {
  centroidFrom,
  knownModules,
  type ProposalRow,
  toProposal,
} from "@/modules/realm/realm.rules.ts";

describe("proposal row", () => {
  const row: ProposalRow = {
    id: "p1",
    slug: "printmakers",
    name: "Printmakers",
    description: null,
    category: null,
    modules: [],
    rationale: "Nowhere else.",
    status: ProposalStatus.pending,
    decisionNote: null,
    decidedAt: null,
    realmId: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    proposerId: "u1",
    proposerName: "Pat",
    proposerEmail: "pat@example.test",
  };

  test("the proposer's columns become one object, and dates become instants", () => {
    const proposal = toProposal(row);
    expect(proposal.proposedBy).toEqual({ id: "u1", name: "Pat", email: "pat@example.test" });
    expect(proposal.createdAt).toEqual(Temporal.Instant.from("2026-05-01T00:00:00Z"));
    expect(proposal.decidedAt).toBeNull();
    expect("proposerId" in proposal).toBe(false);
  });

  test("a proposer who deleted their account leaves no proposer", () => {
    expect(toProposal({ ...row, proposerId: null }).proposedBy).toBeNull();
  });
});

describe("realm centroid", () => {
  test("a stored vector is read as numbers; none means nothing learned", () => {
    expect(centroidFrom({ centroid: "[0.5,0.25]", samples: 4 })).toEqual({
      centroid: [0.5, 0.25],
      samples: 4,
    });
    expect(centroidFrom({ centroid: null, samples: null })).toEqual({ centroid: null, samples: 0 });
    expect(centroidFrom(undefined)).toEqual({ centroid: null, samples: 0 });
  });
});

describe("realm modules", () => {
  test("only modules the code knows, each once, in the order given", () => {
    expect(knownModules([RealmModule.market, 99, RealmModule.jobs, RealmModule.market])).toEqual([
      RealmModule.market,
      RealmModule.jobs,
    ]);
  });
});
