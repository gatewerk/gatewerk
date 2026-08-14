import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Excludes *.test.ts explicitly. Pointing at the bare directory globbed the
  // colocated test files too, and importing vitest from drizzle-kit's CJS loader
  // threw "Vitest cannot be imported in a CommonJS module" — so `db push` and
  // `db generate` failed for everyone, while still exiting 0.
  // Do NOT "simplify" this to ./src/schema/index.ts: that barrel is missing five
  // tables (notifications, notification-preferences, notification-suppressions,
  // slack-user-links, slack-workspaces), so drizzle would read them as dropped
  // and generate a migration deleting them.
  schema: "./src/schema/!(*.test).ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
