-- Migration: timestamp_triggers_and_columns (history alignment stub)
-- Purpose: Align parent (mhln) migration history with repo without re-applying legacy DDL.
-- Notes:
--   * Parent project already has the real DDL from prior manual/remote migrations.
--   * New environments rely on current partition/trigger migrations in this repo.
--   * This stub is a no-op to keep migration versions in sync.

BEGIN;
-- no-op stub for timestamp_triggers_and_columns
COMMIT;

