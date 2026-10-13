import { expect, test } from "bun:test";
import * as v from "valibot";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { schema } from "@akashic/db";
import { insertRow, selectRow } from "@akashic/db/rows";

test("a row schema checks a row's columns, and is not an API view", () => {
  const row = {
    id: "0190a000-0000-7000-8000-000000000000",
    userId: null,
    entityType: "realm",
    entityId: "0190a000-0000-7000-8000-000000000001",
    action: 0,
    changes: null,
    traceId: null,
    occurredAt: new Date("2026-06-01T00:00:00Z"),
  };
  expect(v.parse(selectRow.auditEntries, row)).toEqual(row);
  expect(v.safeParse(selectRow.auditEntries, { ...row, action: "zero" }).success).toBe(false);
});

test("every schema table has a select and an insert row schema", () => {
  const tables = Object.entries(schema)
    .filter(([, value]) => is(value, PgTable))
    .map(([name]) => name)
    .sort();
  expect(Object.keys(selectRow).sort()).toEqual(tables);
  expect(Object.keys(insertRow).sort()).toEqual(tables);
});
