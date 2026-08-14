---
title: Backups
description: What to back up and how to restore a Gatewerk self-hosted instance.
---

## What do I back up?

Two things:

1. **The PostgreSQL database**: contains everything: reviews, templates, audit chain, users, API keys, job queue (pg-boss shares the same database), and webhook delivery history.
2. **The uploads volume**: the `uploads-data` Docker volume, mounted at `/data/uploads` inside the container, stores any uploaded files. If you do not use file uploads, this volume is empty and can be skipped.

## How do I take a backup?

Dump the database with `pg_dump` via the running container:

```bash
docker compose exec gatewerk-db \
  pg_dump -U gatewerk gatewerk > backup-$(date +%Y%m%d-%H%M).sql
```

The service name is `gatewerk-db`, the Postgres user is `gatewerk`, and the database name is `gatewerk`: these are set in the compose file and do not require configuration.

To also snapshot the uploads volume:

```bash
docker run --rm \
  -v gatewerk_uploads-data:/data/uploads:ro \
  -v "$(pwd)":/out \
  alpine tar czf /out/uploads-$(date +%Y%m%d-%H%M).tar.gz -C /data/uploads .
```

**Cron suggestion.** Daily dump to a local directory:

```cron
0 3 * * * cd /opt/gatewerk && docker compose exec -T gatewerk-db pg_dump -U gatewerk gatewerk > backups/gatewerk-$(date +\%Y\%m\%d).sql
```

## How do I restore?

1. Stop the stack: `docker compose down`
2. Drop and recreate the database volume, then start only the database:

   ```bash
   docker volume rm gatewerk_db-data
   docker compose up -d gatewerk-db
   ```

3. Restore the dump:

   ```bash
   docker compose exec -T gatewerk-db \
     psql -U gatewerk gatewerk < backup-YYYYMMDD-HHMM.sql
   ```

4. Start the rest of the stack:

   ```bash
   docker compose up -d
   ```

The `gatewerk-migrate` init container runs on every `compose up` and is idempotent: it skips migration ids already recorded in `schema_migrations`, which will be present in your restored dump. The audit HMAC chain is stored entirely in database rows; dump and restore preserve the chain, and signature verification continues to work correctly after restoration.
