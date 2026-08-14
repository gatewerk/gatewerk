import { PgBoss } from "pg-boss";
import { config } from "../../config";

// Module-singleton pg-boss instance. Shared across OSS and Cloud bootstraps
// so a cloud-mode boot does not spin two PgBoss connections at the same
// connectionString.
let boss: PgBoss | null = null;

export async function getPgBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({
    connectionString: config.databaseUrl,
    retryLimit: 3,
    retryDelay: 30,
    expireInHours: 24,
    archiveCompletedAfterSeconds: 7 * 24 * 60 * 60,
  } as any);
  await boss.start();
  return boss;
}

export async function stopPgBoss(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 10_000 });
    boss = null;
  }
}
