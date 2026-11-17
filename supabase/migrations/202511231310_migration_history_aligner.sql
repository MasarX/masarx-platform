-- Migration: Migration history aligner (no-op placeholder)
-- Purpose: Maintain alignment with remote history while avoiding side-effects
--          in fresh environments. The original aligner wrote to supabase_migrations
--          directly; this placeholder is intentionally empty.
-- Date: 2025-11-23

BEGIN;
-- intentionally empty (history alignment placeholder)
COMMIT;

