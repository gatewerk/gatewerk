import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema/index";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

/**
 * Wide DB type accepted by services and route factories.
 *
 * Production runs on `postgres-js`; the test suite runs on PGlite — both
 * derive from Drizzle's `PgDatabase` base class with the same schema.
 * Typing as the base class lets the same factory accept either driver
 * without forcing tests to do unsafe `as any` casts at every call site.
 */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;

export * from "./schema/index";
export * from "./schemas/index";
