/*
 * Tests for the M0 migration apply pipeline.
 *
 * These tests need a real Postgres because the migration corpus uses
 * `CREATE INDEX CONCURRENTLY` (15, 16, 21, 22), which PGlite does not
 * support. They are gated on the env var TEST_DATABASE_URL — when unset
 * (CI without docker, default `pnpm test`), the suite skips with a clear
 * message rather than failing.
 *
 * Local invocation:
 *   docker run --rm -d --name gw-mig-test -e POSTGRES_PASSWORD=test \
 *     -p 5444:5432 postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:5444/postgres \
 *     pnpm --filter @gatewerk/api test migrate-script
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { runMigrations } from "@gatewerk/db/scripts/migrate";

const CONTROL_URL = process.env.TEST_DATABASE_URL;
const HAS_DB = Boolean(CONTROL_URL);
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "packages", "db", "migrations");

const describeIfDb = HAS_DB ? describe : describe.skip;

async function makeFreshDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!CONTROL_URL) throw new Error("TEST_DATABASE_URL not set");
  const ctrl = postgres(CONTROL_URL, { max: 1, onnotice: () => {} });
  const dbName = `gw_mig_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await ctrl.unsafe(`CREATE DATABASE "${dbName}"`);
  await ctrl.end({ timeout: 5 });
  const u = new URL(CONTROL_URL);
  u.pathname = `/${dbName}`;
  return {
    url: u.toString(),
    drop: async () => {
      const c = postgres(CONTROL_URL, { max: 1, onnotice: () => {} });
      try {
        await c.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await c.end({ timeout: 5 });
      }
    },
  };
}

function silentLog(): (msg: string) => void {
  return () => {};
}

describeIfDb("migrate script — apply path with controlled SQL fixtures", () => {
  // The production migration corpus assumes a base schema already exists
  // (via `drizzle-kit push`) — migration 001 ALTERs `reviews` which no
  // migration creates. To test the *apply* path (vs backfill) we use a
  // tmp directory of self-contained SQL fixtures that don't depend on a
  // pre-existing schema.
  let db: { url: string; drop: () => Promise<void> };
  let fixtureDir: string;

  beforeAll(async () => {
    db = await makeFreshDb();
    fixtureDir = mkdtempSync(join(tmpdir(), "gw-mig-apply-"));
    writeFileSync(
      join(fixtureDir, "001-base.sql"),
      `CREATE TABLE IF NOT EXISTS demo_alpha (id text PRIMARY KEY);`,
    );
    writeFileSync(
      join(fixtureDir, "002-concurrent-index.sql"),
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS demo_alpha_id_idx ON demo_alpha (id);`,
    );
    writeFileSync(
      join(fixtureDir, "003-multi-stmt.sql"),
      `CREATE TABLE IF NOT EXISTS demo_beta (id text PRIMARY KEY, label text);
       CREATE INDEX IF NOT EXISTS demo_beta_label_idx ON demo_beta (label);`,
    );
  });

  afterAll(async () => {
    rmSync(fixtureDir, { recursive: true, force: true });
    await db.drop();
  });

  it("applies all fixture migrations on an empty DB", async () => {
    const result = await runMigrations({
      databaseUrl: db.url,
      migrationsDir: fixtureDir,
      log: silentLog(),
    });

    expect(result.applied).toEqual([
      "001-base",
      "002-concurrent-index",
      "003-multi-stmt",
    ]);
    expect(result.skipped).toHaveLength(0);
    expect(result.backfilled).toHaveLength(0);

    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      // Sentinel: tables created by fixtures must exist (proves SQL executed).
      const alpha = await sql`SELECT to_regclass('public.demo_alpha')::text AS t`;
      expect(alpha[0].t).toBe("demo_alpha");
      const beta = await sql`SELECT to_regclass('public.demo_beta')::text AS t`;
      expect(beta[0].t).toBe("demo_beta");
      // CREATE INDEX CONCURRENTLY (which can't run inside a transaction)
      // must have succeeded, proving sql.unsafe() uses simple-query protocol.
      const idx = await sql<{ exists: string | null }[]>`
        SELECT to_regclass('public.demo_alpha_id_idx')::text AS exists
      `;
      expect(idx[0].exists).toBe("demo_alpha_id_idx");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("is a no-op on the second run", async () => {
    const result = await runMigrations({
      databaseUrl: db.url,
      migrationsDir: fixtureDir,
      log: silentLog(),
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toEqual([
      "001-base",
      "002-concurrent-index",
      "003-multi-stmt",
    ]);
    expect(result.backfilled).toHaveLength(0);
  });

  it("re-applies only the ids deleted from schema_migrations", async () => {
    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      await sql`DELETE FROM schema_migrations WHERE id = '002-concurrent-index'`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const result = await runMigrations({
      databaseUrl: db.url,
      migrationsDir: fixtureDir,
      log: silentLog(),
    });
    expect(result.applied).toEqual(["002-concurrent-index"]);
    expect(result.skipped.sort()).toEqual(["001-base", "003-multi-stmt"]);
  });
});

describeIfDb("migrate script — production migration corpus", () => {
  // Validates the script against the real `packages/db/migrations/` against
  // the expected production scenario: established DB with base schema in
  // place. Bootstraps `templates` only (the backfill sentinel) so the
  // backfill branch records every on-disk id without executing the SQL.
  it("backfills the entire production corpus and re-runs cleanly", async () => {
    const db = await makeFreshDb();
    try {
      const sql = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(
          `CREATE TABLE templates (id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL);`,
        );
      } finally {
        await sql.end({ timeout: 5 });
      }

      const onDisk = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => f.replace(/\.sql$/, ""));

      const first = await runMigrations({
        databaseUrl: db.url,
        migrationsDir: MIGRATIONS_DIR,
        log: silentLog(),
      });
      expect(first.backfilled).toEqual(onDisk);
      expect(first.applied).toHaveLength(0);

      const second = await runMigrations({
        databaseUrl: db.url,
        migrationsDir: MIGRATIONS_DIR,
        log: silentLog(),
      });
      expect(second.applied).toHaveLength(0);
      expect(second.skipped).toEqual(onDisk);
      expect(second.backfilled).toHaveLength(0);
    } finally {
      await db.drop();
    }
  });
});

describeIfDb("migrate script — established DB backfill (no SQL execution)", () => {
  let db: { url: string; drop: () => Promise<void> };

  beforeAll(async () => {
    db = await makeFreshDb();
    // Pre-create the sentinel `templates` table so the auto-backfill branch
    // triggers. Crucially: do NOT create chain_runs — its presence after the
    // run would prove the script actually executed migration 022 (which
    // would be a bug under the backfill path).
    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`
        CREATE TABLE templates (
          id text PRIMARY KEY,
          slug text NOT NULL,
          name text NOT NULL
        );
      `);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  afterAll(async () => {
    await db.drop();
  });

  it("backfills every migration id without executing any", async () => {
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => f.replace(/\.sql$/, ""));

    const result = await runMigrations({
      databaseUrl: db.url,
      migrationsDir: MIGRATIONS_DIR,
      log: silentLog(),
    });

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.backfilled).toEqual(onDisk);

    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM schema_migrations ORDER BY id
      `;
      expect(rows.map((r) => r.id)).toEqual(onDisk);

      // Proof the script did NOT actually re-execute migrations: chain_runs
      // (created by 022) must not exist, since we only created `templates`
      // by hand and the backfill path skips execution.
      const chainRuns = await sql`SELECT to_regclass('public.chain_runs')::text AS t`;
      expect(chainRuns[0].t).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describeIfDb("migrate script — failure path", () => {
  it("exits with thrown error on malformed SQL and releases the advisory lock", async () => {
    const db = await makeFreshDb();
    try {
      const tmp = mkdtempSync(join(tmpdir(), "gw-mig-bad-"));
      try {
        mkdirSync(tmp, { recursive: true });
        writeFileSync(
          join(tmp, "001-broken.sql"),
          "this is not valid SQL at all;",
        );

        await expect(
          runMigrations({
            databaseUrl: db.url,
            migrationsDir: tmp,
            log: silentLog(),
          }),
        ).rejects.toThrow();

        // Lock must be released — verify by acquiring it from a brand-new session.
        const sql = postgres(db.url, { max: 1, onnotice: () => {} });
        try {
          const rows = await sql<{ ok: boolean }[]>`
            SELECT pg_try_advisory_lock(7423842) AS ok
          `;
          expect(rows[0].ok).toBe(true);
          await sql`SELECT pg_advisory_unlock(7423842)`;
        } finally {
          await sql.end({ timeout: 5 });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      await db.drop();
    }
  });
});

if (!HAS_DB) {
  console.warn(
    "[migrate-script.test] TEST_DATABASE_URL not set — skipping. " +
      "Run `docker run --rm -d --name gw-mig-test -e POSTGRES_PASSWORD=test " +
      "-p 5444:5432 postgres:16` and set TEST_DATABASE_URL to enable.",
  );
}
