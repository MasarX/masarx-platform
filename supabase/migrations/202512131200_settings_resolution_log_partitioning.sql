-- Migration: settings_resolution_log partition maintenance (partitioning_config + guard)
-- Purpose: Prevent runtime failures when month rolls over by making settings_resolution_log
--          participate in create_next_partitions() and ensuring partitions exist on-demand.
-- Alignment: SIMPLE · SCALABLE · DYNAMIC · ZERO HARD CODING (row-driven via partitioning_config)
-- Date: 2025-12-13

BEGIN;

-- 1) Register settings_resolution_log in partitioning_config (HASH+RANGE monthly)
INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
)
VALUES (
  'settings_resolution_log',
  'HASH+RANGE',
  'organization_id|resolved_at',
  'monthly',
  NULL,
  12,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET partition_strategy = EXCLUDED.partition_strategy,
    partition_key = EXCLUDED.partition_key,
    partition_interval = EXCLUDED.partition_interval,
    partitions_ahead = EXCLUDED.partitions_ahead,
    retention_months = EXCLUDED.retention_months,
    config = EXCLUDED.config;

-- 2) Guard: ensure current-month RANGE partitions exist before inserting provenance
CREATE OR REPLACE FUNCTION public.log_settings_resolution(
    p_organization_id UUID,
    p_category TEXT,
    p_winning_scope_type TEXT,
    p_winning_scope_id UUID,
    p_winning_settings_id UUID,
    p_winning_settings_version_id UUID,
    p_winning_version INT,
    p_scope_path JSONB DEFAULT '[]'::jsonb,
    p_inputs JSONB DEFAULT '{}'::jsonb,
    p_merge_notes JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
  v_hash_parent RECORD;
  v_remainder INT;
  v_partition_base TEXT;
  v_expected_partition TEXT;
  v_missing BOOLEAN := FALSE;
BEGIN
  -- Ensure the current-month partition exists for every HASH parent (future-proof for modulus expansion).
  v_partition_base := public.generate_partition_name_range_monthly('settings_resolution_log', now());

  FOR v_hash_parent IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'settings_resolution_log'
      AND c.relkind = 'r'
    ORDER BY c.relname
  LOOP
    SELECT COALESCE(NULLIF(regexp_replace(v_hash_parent.relname, '.*_p([0-9]+)$', '\1'),''), '0')::int
      INTO v_remainder;

    v_expected_partition := v_partition_base;
    IF v_remainder > 0 THEN
      v_expected_partition := format('%s_p%s', v_expected_partition, v_remainder);
    END IF;

    IF to_regclass('public.' || v_expected_partition) IS NULL THEN
      v_missing := TRUE;
      EXIT;
    END IF;
  END LOOP;

  IF v_missing THEN
    PERFORM public.create_next_partitions();
  END IF;

  INSERT INTO public.settings_resolution_log(
    id, organization_id, category, scope_path,
    winning_scope_type, winning_scope_id,
    winning_settings_id, winning_settings_version_id, winning_version,
    merge_notes, inputs, resolved_at, created_at
  ) VALUES (
    v_id, p_organization_id, p_category, COALESCE(p_scope_path, '[]'::jsonb),
    p_winning_scope_type, p_winning_scope_id,
    p_winning_settings_id, p_winning_settings_version_id, p_winning_version,
    p_merge_notes, p_inputs, now(), now()
  );

  RETURN v_id;
END;
$$;

ALTER FUNCTION public.log_settings_resolution(UUID, TEXT, TEXT, UUID, UUID, UUID, INT, JSONB, JSONB, JSONB)
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.log_settings_resolution(UUID, TEXT, TEXT, UUID, UUID, UUID, INT, JSONB, JSONB, JSONB)
  IS 'Insert settings resolution provenance and return id (ensures partitions exist).';

-- 3) Bootstrap partitions now (idempotent; uses partitioning_config)
SELECT * FROM public.create_next_partitions();

COMMIT;

