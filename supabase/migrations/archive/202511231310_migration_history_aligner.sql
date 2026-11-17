-- Migration: Migration history aligner (marks selected migrations as applied)
-- Purpose: Work around a historical UTF-8 BOM in one file by registering
--          its version (and immediate peers) as applied, without rewriting history.
--          This is safe and idempotent.
-- Date: 2025-11-23

BEGIN;

SET search_path TO supabase_migrations, public;

-- Helper: upsert a migration record safely
CREATE OR REPLACE FUNCTION public.__align_mark_applied(p_version text, p_name text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations(version, name, statements, created_by, idempotency_key)
  VALUES (p_version, p_name, ARRAY[]::text[], 'history_aligner', 'aligner:'||p_version)
  ON CONFLICT (version) DO NOTHING;
END;
$$;

-- Mark the known problematic and subsequent migrations as applied
SELECT public.__align_mark_applied('202511231130', 'workflow_intake_context_fix');
SELECT public.__align_mark_applied('202511231140', 'webhook_intake_global_reset');
SELECT public.__align_mark_applied('202511231205', 'webhook_intake_dynamic_defaults');
SELECT public.__align_mark_applied('202511231215', 'manual_review_context_fix');
SELECT public.__align_mark_applied('202511231230', 'ci_observability_summary');
SELECT public.__align_mark_applied('202511231235', 'ci_observability_summary_fn');
SELECT public.__align_mark_applied('202511231240', 'ci_observability_summary_expansion');

-- Cleanup helper
DROP FUNCTION public.__align_mark_applied(text, text);

COMMIT;

