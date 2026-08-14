import { describe, it, expect } from "vitest";
import { containsConcurrentIndex } from "@gatewerk/db/scripts/migrate";

// Wave 3 P2 — pure-function unit coverage for the CONCURRENTLY-detect
// heuristic that decides whether a migration applies inside a transaction.
// Postgres-free; runs in the default test set.
describe("containsConcurrentIndex", () => {
  it("returns true for CREATE INDEX CONCURRENTLY", () => {
    expect(
      containsConcurrentIndex(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON x (id);`,
      ),
    ).toBe(true);
  });

  it("returns true for CREATE UNIQUE INDEX CONCURRENTLY", () => {
    expect(
      containsConcurrentIndex(
        `CREATE UNIQUE INDEX CONCURRENTLY x_uniq ON x (id);`,
      ),
    ).toBe(true);
  });

  it("returns true for case-insensitive matches", () => {
    expect(
      containsConcurrentIndex(`create index concurrently x_idx ON x (id);`),
    ).toBe(true);
    expect(
      containsConcurrentIndex(`Create Unique Index Concurrently x_uniq ON x;`),
    ).toBe(true);
  });

  it("returns true with extra whitespace and newlines between keywords", () => {
    expect(
      containsConcurrentIndex(
        `CREATE\n  INDEX\n  CONCURRENTLY\n  IF NOT EXISTS x_idx ON x (id);`,
      ),
    ).toBe(true);
  });

  it("returns false for plain CREATE INDEX (no CONCURRENTLY keyword)", () => {
    expect(
      containsConcurrentIndex(`CREATE INDEX IF NOT EXISTS x_idx ON x (id);`),
    ).toBe(false);
  });

  it("returns false for unrelated DDL", () => {
    expect(
      containsConcurrentIndex(`ALTER TABLE x ADD COLUMN y text;`),
    ).toBe(false);
    expect(containsConcurrentIndex(``)).toBe(false);
  });

  it("returns true if any statement in a multi-statement migration matches", () => {
    expect(
      containsConcurrentIndex(`
        CREATE TABLE x (id text PRIMARY KEY);
        CREATE INDEX CONCURRENTLY x_id_idx ON x (id);
      `),
    ).toBe(true);
  });
});
