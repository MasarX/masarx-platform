# Database Migration Guide

This guide explains how to create, test, and deploy database migrations for the MasarX Delivery Platform.

## Table of Contents

1. [Migration Workflow Overview](#1-migration-workflow-overview)
2. [Creating New Migrations](#2-creating-new-migrations)
3. [Testing Migrations (Cloud and Local)](#3-testing-migrations-cloud-and-local)
4. [Committing Migrations](#4-committing-migrations)
5. [Migration Best Practices](#5-migration-best-practices)
6. [Rollback Procedures](#6-rollback-procedures)
7. [Common Patterns](#7-common-patterns)

---

## 1. Migration Workflow Overview

The migration workflow follows a simple four-step cycle:

```
Create -> Lint -> Push -> Verify -> Commit
(iterate)
```

### Workflow Steps

1. **Create** - Write SQL migration file with timestamp prefix
2. **Lint** - Run `npm run lint:db` and `npm run lint:structure` (fast safety checks)
3. **Push** - Apply migrations to the target cloud database via `npx supabase db push --db-url "$DATABASE_URL"`
4. **Verify** - Run cloud verification (`npm run verify:cloud:core`) and confirm behavior
5. **Commit** - Git commit the migration file (append-only)

### Why This Workflow?

- **Cloud-first correctness:** CI/gates run against cloud; verify changes where they will ship.
- **Fast safety checks:** db/structure lint catches common mistakes before any push.
- **Atomic commits:** Keep migrations small and append-only for safe roll-forward.
- **Local is optional:** Use a local Supabase stack only when you need tight iteration loops or destructive resets.

---

## 2. Creating New Migrations

### 2.1 Using Supabase CLI

The recommended way to create migrations:

```bash
# Create new migration with descriptive name
supabase migration new add_customer_ratings_table

# This creates: supabase/migrations/20251011120345_add_customer_ratings_table.sql
```

- **File Naming Convention:**
  - Format: `YYYYMMDDHHMM[SS]_description.sql` (10-14 digit timestamp prefix)
  - Example: `20251011120345_add_customer_ratings_table.sql` (Supabase CLI default)
  - `npm run lint:db` enforces naming and duplicate timestamp checks (do not rename historical migrations)
- Timestamp ensures migrations run in order
- Description should be clear and concise

### 2.2 Manual Creation

If you prefer to create files manually:

```bash
# 1. Generate timestamp
date +%Y%m%d%H%M%S  # Linux/Mac
Get-Date -Format "yyyyMMddHHmmss"  # Windows PowerShell

# 2. Create file with format: <timestamp>_<description>.sql
# Example: 20251011120345_add_customer_ratings_table.sql
```

### 2.3 Migration File Structure

Every migration file should follow this structure:

```sql
-- Migration: Add customer ratings table
-- Created: 2025-10-11
-- Purpose: Enable customers to rate deliveries

-- ====================
-- SCHEMA CHANGES
-- ====================

CREATE TABLE IF NOT EXISTS customer_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ====================
-- INDEXES
-- ====================

CREATE INDEX IF NOT EXISTS idx_customer_ratings_shipment
  ON customer_ratings(shipment_id);

CREATE INDEX IF NOT EXISTS idx_customer_ratings_customer
  ON customer_ratings(customer_id, created_at DESC);

-- ====================
-- PARTITIONING (if needed)
-- ====================

-- Example: If table needs partitioning
-- See Section 7.1 for partitioning patterns

-- ====================
-- ROW-LEVEL SECURITY (if needed)
-- ====================

-- Enable RLS
ALTER TABLE customer_ratings ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own ratings
CREATE POLICY customer_ratings_select_policy ON customer_ratings
  FOR SELECT
  USING (customer_id = auth.uid());

-- ====================
-- SEED DATA (optional)
-- ====================

-- Only configuration data, not test data
-- Test data belongs in scripts/data/seed-test-data.js
```

#### Timestamp + Audit Contract (Required)

For every new `public` base table (non-partition leaf), migrations must follow the canonical timestamp + audit contract (row-driven, SSOT):

- **Canonical timestamps:** prefer `created_at` and `updated_at` as `timestamptz`. Append-only ledgers/logs may set `updated_at_required=false` via contract.
- **Contract row:** insert a row into `public.table_contracts` for the table (`created_at_required`, `updated_at_required`, `audit_enabled`). This is enforced by pgTAP and prevents hardcoded table branching.
- **Audit triggers:** after creating the table + contract row, call `SELECT * FROM public.ensure_audit_triggers();` in the migration so audit triggers are reconciled immediately (do not wait for cron).
- **Audit privacy:** if the table contains sensitive columns (tokens, credentials, payloads), add/update `public.audit_redaction_rules` (denylist/allowlist) so `audit_table_changes` never leaks secrets.

### 2.4 What Goes in Migrations?

**- DO Include:**
- Schema changes (CREATE, ALTER, DROP tables)
- Index creation
- Calls to partition helpers (`public.apply_partition_index_templates()`) to keep RANGE partitions aligned
- RLS policies
- Partition table creation
- Database functions
- Configuration seed data (partitioning_config, worker_registry)

**X DON'T Include:**
- Test data (use seed scripts instead)
- Hardcoded business logic (use config tables)
- Client-specific code (use settings_versions + scripts/data provisioning)
- Provider credentials, tokens, or per-client URLs (use scripts/clients/provision-client.js and scripts/clients/provision-webhook-source.js)
- API endpoints (Edge Functions, not migrations)

### 2.5 Anti-patterns blocked in lint
- Provider-specific settings categories (e.g., `provider_logestechs_defaults`). Use neutral `provider_defaults` and scope by `scope_type = 'resource'`, `scope_id = provider_id`.
- Hardcoded channel mapping in handlers (e.g., switching on operation names). Use `operation_templates.call_type` or step metadata instead.

---

## 5. Migration Best Practices

### 5.1 Small, Focused Changes

**Good:** One migration per logical change
```
20251011120000_add_customer_ratings_table.sql
20251011130000_add_delivery_photos_table.sql
20251011140000_add_rating_index.sql
```

**Bad:** Multiple unrelated changes
```
20251011120000_add_all_new_features.sql  # X Too broad
```

### 5.2 Idempotent Migrations

Always use `IF NOT EXISTS` / `IF EXISTS`:

```sql
-- - Good: Idempotent
CREATE TABLE IF NOT EXISTS customer_ratings (...);
CREATE INDEX IF NOT EXISTS idx_customer_ratings_shipment ON ...;
DROP TABLE IF EXISTS old_legacy_table;

-- X Bad: Will fail on re-run
CREATE TABLE customer_ratings (...);
CREATE INDEX idx_customer_ratings_shipment ON ...;
DROP TABLE old_legacy_table;
```

Also ensure extension helpers are resolvable on fresh databases:
- Set `search_path` to include `extensions` when calling functions like `crypt()`/`gen_random_uuid()`, or schema-qualify them.
- The repo CLI wrapper already injects `search_path=public,extensions` for `db push`, but migrations should remain explicit when relying on extension helpers.

### 5.3 Avoid Breaking Changes

**Additive Changes (Safe):**
- Add new table
- Add new column (with default value)
- Add new index
- Add new RLS policy

**Breaking Changes (Dangerous):**
- Drop table (data loss)
- Drop column (data loss)
- Change column type (may fail with data)
- Rename column (breaks queries)

**If Breaking Change Needed:**
1. Add new table/column first
2. Migrate data gradually
3. Update application code
4. Remove old table/column in separate migration

### 5.4 Partition Tables from the Start

**Critical Rule:** PostgreSQL cannot add partitioning to existing tables with data.

```sql
-- - Good: Create partitioned from the start
CREATE TABLE customer_ratings (
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  rating integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY HASH (customer_id);

CREATE TABLE customer_ratings_p0 PARTITION OF customer_ratings
  FOR VALUES WITH (MODULUS 1, REMAINDER 0);

-- X Bad: Create non-partitioned, try to partition later
CREATE TABLE customer_ratings (...);  -- Can't partition after data exists!
```

### 5.5 Test Performance Impact

For indexes on large tables:

```sql
-- - Good: Use CONCURRENTLY (doesn't lock table)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shipments_tracking
  ON shipments(tracking_number);

-- X Bad: Locks table during creation
CREATE INDEX idx_shipments_tracking ON shipments(tracking_number);
```

### 5.6 Document Complex Logic

Add comments for non-obvious decisions:

```sql
-- Partition by customer_id (HASH) instead of created_at (RANGE)
-- Reasoning: Queries filter by customer_id more than date range
-- Trade-off: Can't easily archive old partitions, but better query performance
CREATE TABLE customer_ratings (...)
  PARTITION BY HASH (customer_id);
```

### 5.7 Separate Schema and Data

**Migration:** Schema only
```sql
-- 20251011120000_add_customer_ratings_table.sql
CREATE TABLE customer_ratings (...);
```

**Seed Script:** Data
```javascript
// scripts/data/seed-test-data.js
await client.query(`
  INSERT INTO customer_ratings (...)
  VALUES (...)
`);
```

### 5.8 Use Partition Index Templates

- Never enumerate RANGE partition indexes manually (`idx_webhook_log_2025_w41_timestamp`, etc.).
- Add indexes to the template partition (usually `_p0`) and rely on `public.apply_partition_index_templates()` in migrations to propagate definitions.
- Schedule `public.apply_partition_index_templates()` via cron (already provided) for ongoing coverage.
- If legacy indexes exist, add a follow-up migration to `DROP INDEX IF EXISTS` and re-run the template helper (see 202511150900_drop_manual_partition_indexes.sql for reference).

### 5.9 Provision Client-Specific Data via Scripts

- Client-specific DML (recipients, webhook sources, custom policies) must live in `scripts/data/`.
- Use the reusable provisioning scripts:
  - `npm run provision:client` -> wraps webhook ingest policy + outbound WhatsApp configuration.
  - `npm run provision:webhook-source` -> creates senders, mappings, and webhook sources.
- Archived migrations remain under `supabase/migrations/archive/` for historical context (see `202510150201_seed_client2_whatsapp.sql`).
- db-lint enforces this rule; migrations containing `test tokens`, `dialog360::whatsapp::...`, or `seed_client` will fail CI.


### 5.11 No Time-Bound Partitions in DDL

- Do not create date-specific RANGE partitions directly in migrations (e.g., \CREATE TABLE decision_log_2025_10 PARTITION OF...\, \webhook_log_2025_w41\).
- Instead, define partition strategies in \partitioning_config\ and rely on:
  - \public.create_next_partitions()\ to create upcoming RANGE partitions (weekly/monthly) under the correct parents.
  - \public.apply_partition_index_templates()\ to propagate indexes onto new partitions.
  - pg_cron schedules to maintain partitions automatically (see \202511140420_partition_cron_and_index_helpers.sql\).
- If a fresh environment needs immediate partitions, add a bootstrap migration that calls \SELECT * FROM public.create_next_partitions();\ (see \202511231455_partition_bootstrap_create_next.sql\).
- Use the provided name helpers for any derived logic: \generate_partition_name_range_weekly/monthly\.
- Indexes must never be hard-coded per date-suffixed partition. Use the template propagation helper or schedule.

The structure lint warns on time-bound partition DDL in new migrations and fails CI for newly added files that violate this rule.
### 5.10 Lint Warnings Policy (Handlers & Dynamic Dispatch)

- Aim for warning-free PL/pgSQL, but two cases remain acceptable:
  - Dynamic handler dispatch within `progress_workflow_run` uses registry-driven dynamic SQL by design.
  - Standardised handler signatures receive a `p_operation_result` argument that may be unused; keep the signature for forward compatibility.
- Do not add broad suppressions. Where practical, consume unused parameters or add lightweight validations, and document intentional warnings.

---

## 7. Common Patterns

### 7.1 Adding Partitioned Table

**Pattern:** HASH partition by client_id for multi-tenant data

```sql
-- Create parent table (partitioned)
CREATE TABLE delivery_photos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL,
  client_id uuid NOT NULL,
  photo_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY HASH (client_id);

-- Create default partition (MODULUS 1 for future expansion)
CREATE TABLE delivery_photos_p0 PARTITION OF delivery_photos
  FOR VALUES WITH (MODULUS 1, REMAINDER 0);

-- Add to partitioning config (for monitoring)
INSERT INTO partitioning_config (
  table_name,
  partition_type,
  partition_key,
  current_modulus,
  target_modulus
) VALUES (
  'delivery_photos',
  'HASH',
  'client_id',
  1,
  4  -- Can expand to 4 partitions later
);
```

### 7.2 Adding RLS Policy

**Pattern:** Client-specific data isolation

```sql
-- Enable RLS
ALTER TABLE delivery_photos ENABLE ROW LEVEL SECURITY;

-- Policy: Select only own client's data
CREATE POLICY delivery_photos_select_policy ON delivery_photos
  FOR SELECT
  USING (
    client_id = (current_setting('request.jwt.claims', true)::jsonb->>'client_id')::uuid
  );

-- Policy: Insert only for own client
CREATE POLICY delivery_photos_insert_policy ON delivery_photos
  FOR INSERT
  WITH CHECK (
    client_id = (current_setting('request.jwt.claims', true)::jsonb->>'client_id')::uuid
  );
```

### 7.3 Adding Performance Index

**Pattern:** Composite index for common query pattern

```sql
-- Query pattern: Filter by shipment, order by created_at
SELECT * FROM delivery_photos
WHERE shipment_id = $1
ORDER BY created_at DESC;

-- Index to support this query
CREATE INDEX IF NOT EXISTS idx_delivery_photos_shipment_created
  ON delivery_photos(shipment_id, created_at DESC);

-- For large tables, use CONCURRENTLY
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delivery_photos_shipment_created
  ON delivery_photos(shipment_id, created_at DESC);
```

### 7.4 Modifying Partition Strategy

**Pattern:** Expand HASH MODULUS (1 -> 4)

```sql
-- Step 1: Create new partitions
CREATE TABLE delivery_photos_p1 PARTITION OF delivery_photos
  FOR VALUES WITH (MODULUS 4, REMAINDER 1);

CREATE TABLE delivery_photos_p2 PARTITION OF delivery_photos
  FOR VALUES WITH (MODULUS 4, REMAINDER 2);

CREATE TABLE delivery_photos_p3 PARTITION OF delivery_photos
  FOR VALUES WITH (MODULUS 4, REMAINDER 3);

-- Step 2: Detach old partition
ALTER TABLE delivery_photos DETACH PARTITION delivery_photos_p0;

-- Step 3: Update first partition to MODULUS 4
-- (Requires data migration, complex - avoid if possible)

-- Step 4: Update config
UPDATE partitioning_config
SET current_modulus = 4
WHERE table_name = 'delivery_photos';
```

**Note:** Expanding MODULUS requires data migration. Plan carefully!

### 7.5 Adding RANGE Partition

**Pattern:** Weekly partition for high-volume logs

```sql
-- Create parent table (partitioned by created_at)
CREATE TABLE delivery_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  shipment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Create initial partitions (4 weeks)
CREATE TABLE delivery_events_2025_w41 PARTITION OF delivery_events
  FOR VALUES FROM ('2025-10-07') TO ('2025-10-14');

CREATE TABLE delivery_events_2025_w42 PARTITION OF delivery_events
  FOR VALUES FROM ('2025-10-14') TO ('2025-10-21');

CREATE TABLE delivery_events_2025_w43 PARTITION OF delivery_events
  FOR VALUES FROM ('2025-10-21') TO ('2025-10-28');

CREATE TABLE delivery_events_2025_w44 PARTITION OF delivery_events
  FOR VALUES FROM ('2025-10-28') TO ('2025-11-04');

-- Add to partitioning config
INSERT INTO partitioning_config (
  table_name,
  partition_type,
  partition_key,
  range_interval,
  retention_days
) VALUES (
  'delivery_events',
  'RANGE',
  'created_at',
  '7 days',  -- Weekly
  30  -- Keep 30 days
);
```

### 7.6 Adding Function

**Pattern:** Partition management function

```sql
-- Function to create next week's partition
CREATE OR REPLACE FUNCTION create_next_delivery_events_partition()
RETURNS void AS $$
DECLARE
  next_week_start date;
  next_week_end date;
  partition_name text;
BEGIN
  -- Calculate next week
  next_week_start := date_trunc('week', now() + interval '1 week');
  next_week_end := next_week_start + interval '7 days';

  -- Generate partition name (e.g., delivery_events_2025_w45)
  partition_name := 'delivery_events_' || to_char(next_week_start, 'YYYY_"w"IW');

  -- Create partition
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF delivery_events
     FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    next_week_start,
    next_week_end
  );

  RAISE NOTICE 'Created partition: %', partition_name;
END;
$$ LANGUAGE plpgsql;
```

---

## Summary Checklist

Before committing a migration:

- [ ] Migration file has timestamp prefix
- [ ] `npm run lint:db` passes (naming + Supabase lint)
- [ ] Uses `IF NOT EXISTS` / `IF EXISTS` (idempotent)
- [ ] Tested on a real database:
  - Cloud: `npm test` (or `npm run verify:cloud:core`)
  - Local (optional): `npm run local:start` + `npx supabase@2 db reset --yes`
- [ ] Verified in Studio UI
- [ ] All tests pass (`npm test` -> `npm run verify:cloud:core`)
- [ ] Partition tables created correctly (if applicable)
- [ ] RLS policies enabled (if needed)
- [ ] Indexes created with CONCURRENTLY (for large tables)
- [ ] No hardcoded client IDs or business logic
- [ ] Complex logic is documented with comments
- [ ] Individual git commit with clear message

---

## Next Steps

- **Test Your Migrations:** Prefer `npm test` (cloud gate); use `supabase db reset` only on local sandboxes.
- **Understand Partitioning:** Study existing migrations 3-6 for partition patterns
- **Monitor Performance:** Check query plans in Studio for new indexes
- **Read Testing Guide:** [TESTING_GUIDE.md](./TESTING_GUIDE.md) for test strategies
