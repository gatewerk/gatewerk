---
title: Upgrades
description: How to apply a new version of Gatewerk and what to do if a migration fails.
---

## How do I upgrade?

Pull the latest code and rebuild:

```bash
git pull
docker compose up -d --build
```

That is the complete upgrade path. The `gatewerk-migrate` init container runs first, applies any new migration files, and exits before the API starts. If the migration succeeds, the new API image starts. If it fails, the API does not start and the prior running containers are unaffected.

## What if a migration fails?

The `gatewerk-migrate` container exits non-zero, `gatewerk-api` does not start (its `depends_on: service_completed_successfully` blocks it), and the deploy fails fast. To diagnose:

```bash
docker compose logs gatewerk-migrate
```

The output identifies the failing migration id and the SQL error. For example:

```
APPLY 074_add_expiry_index ... ERROR: column "expires_at" does not exist
```

Fix the migration SQL (or revert the offending commit) and redeploy with `docker compose up -d --build`. Every migration in the corpus is written with `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` throughout, so re-running after a partial failure is safe.

## How do I check the migration state?

Query the `schema_migrations` table directly:

```bash
docker compose exec gatewerk-db \
  psql -U gatewerk gatewerk \
  -c 'SELECT id, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 5;'
```

Expected output shows the five most recently applied migration ids and when they were recorded. The top row is the latest applied migration.

```
       id        |          applied_at
-----------------+-------------------------------
 073_add_...     | 2026-07-11 08:37:46.123456+00
 072_add_...     | 2026-07-04 22:34:10.987654+00
 071_add_...     | 2026-07-04 22:34:10.456789+00
(3 rows)
```

## How do fresh installs bootstrap?

When `docker compose up` runs against a completely empty database (no prior schema), the migrate container detects the absence of both `schema_migrations` and the `templates` table and applies `packages/db/scripts/baseline.sql` instead of running every individual migration file. The baseline materialises the full schema in one step, marks all covered migration ids as applied, and then falls through to apply any migration files that postdate the baseline. Fresh installs and upgrade paths converge at the same schema state.
