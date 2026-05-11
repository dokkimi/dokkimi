# Shared Prisma Schema

This directory contains the shared Prisma schema and migrations used by both Control Tower and Log Processor Service.

## Structure

- `schema.prisma` - The shared database schema definition
- `prisma.config.ts` - Prisma 7.x configuration file (defines datasource URL)
- `migrations/` - Prisma migration history (applied to both services)

## Usage

Both services reference this schema using Prisma's `--schema` flag:

```bash
# Generate Prisma Client
yarn prisma:generate

# Create a new migration
yarn prisma:migrate

# Apply migrations (production)
yarn prisma:deploy
```

## Running Migrations (Development)

Prisma 7.x uses `prisma.config.ts` for the datasource URL. The config defaults to `file:~/.dokkimi/dokkimi.db` (the desktop DB) so you can run migrations directly from this directory:

```bash
cd shared/prisma
npx prisma migrate dev --name your_migration_name
```

Alternatively, you can run from a service directory:

```bash
cd services/control-tower
yarn prisma:migrate --name your_migration_name
```

After creating a migration, regenerate the Prisma client:

```bash
cd services/control-tower
yarn prisma:generate
```

## How It Works

Prisma 7.x automatically detects `prisma.config.ts` in the same directory as the schema:

1. Uses the schema file specified in the config
2. Uses the datasource URL from the config
3. Looks for migrations in `shared/prisma/migrations/` (same directory as schema)
4. Generates the Prisma Client based on the schema

## TimescaleDB Setup (Cloud Only)

For cloud deployments using PostgreSQL with TimescaleDB, run the setup script after migrations:

```bash
psql $DATABASE_URL -f ../../scripts/timescaledb/setup_hypertables.sql
```

This converts time-series tables (`actions`, `console_logs`, `pod_metrics`) into TimescaleDB hypertables for optimized querying.
