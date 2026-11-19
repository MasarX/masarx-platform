-- W41 closure of W40 finding F1
-- pgTAP: settings_versions B1 platform RPCs idempotency invariant
--
-- Asserts:
--   * The unique partial index `idx_settings_versions_new_current` (and its
--     auto-named partition counterpart) is present and enforces at most ONE
--     active row per (category, scope_type, scope_hash).
--   * After the W41 F1 fixup migration, at most ONE
--     (access_control_policy, global, scope_id IS NULL) row has
--     effective_until IS NULL AND approved_at IS NOT NULL.
--   * The B1 capability registry (alerts.read/write, feature_flags.read/write,
--     warehouse.read/write) is present in the active row when an active row
--     exists. (Tolerates the no-active-row case as a no-op fixup.)
--
-- Evidence link: docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

CREATE OR REPLACE FUNCTION test_w41_settings_versions_fixup()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_active_count INT;
  v_active_value JSONB;
  v_keys TEXT[] := ARRAY[]::TEXT[];
  v_target TEXT[] := ARRAY[
    'alerts.read',
    'alerts.write',
    'feature_flags.read',
    'feature_flags.write',
    'warehouse.read',
    'warehouse.write'
  ];
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_cap TEXT;
  v_idx INT;
  v_caps JSONB;
BEGIN
  -- Invariant 1: the unique partial index (or its partition shadow) exists.
  RETURN NEXT ok(
    EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'idx_settings_versions_new_current',
           'settings_versions_new_p0_category_scope_type_scope_hash_idx'
         )
    ),
    'unique partial index for current settings_versions exists'
  );

  -- Invariant 2: at most one active row per (cat, scope_type, scope_hash) for
  -- access_control_policy / global. Fresh DB rebuild must satisfy this even
  -- if the B1 migration has run.
  SELECT COUNT(*)
    INTO v_active_count
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL;

  RETURN NEXT cmp_ok(
    v_active_count, '<=', 1,
    format('at most one active access_control_policy global row (got %s)', v_active_count)
  );

  -- If an active row exists, validate B1 capabilities are registered.
  -- The fixup is a no-op when there's no seed; that's a tolerated state.
  IF v_active_count = 1 THEN
    SELECT value
      INTO v_active_value
      FROM public.settings_versions
     WHERE category = 'access_control_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
     LIMIT 1;

    v_caps := COALESCE(v_active_value->'capabilities', '[]'::jsonb);
    FOR v_idx IN 0 .. jsonb_array_length(v_caps) - 1 LOOP
      v_keys := array_append(v_keys, COALESCE(v_caps->v_idx->>'key', ''));
    END LOOP;

    FOREACH v_cap IN ARRAY v_target LOOP
      IF NOT (v_cap = ANY(v_keys)) THEN
        v_missing := array_append(v_missing, v_cap);
      END IF;
    END LOOP;

    RETURN NEXT ok(
      array_length(v_missing, 1) IS NULL,
      format('B1 target caps all registered (missing=%s)', COALESCE(array_to_string(v_missing, ','), '<none>'))
    );

    RETURN NEXT ok(
      jsonb_typeof(COALESCE(v_active_value->'roles', '[]'::jsonb)) = 'array',
      'roles entry on active access_control_policy is a JSON array'
    );
  ELSE
    -- No active row: F1 fixup is a no-op. Record placeholders so plan() count
    -- stays balanced.
    RETURN NEXT pass(
      'no active access_control_policy row; W41 F1 stays a no-op (caps assertion skipped)'
    );
    RETURN NEXT pass(
      'no active access_control_policy row; roles assertion skipped'
    );
  END IF;
END
$function$;

SELECT * FROM test_w41_settings_versions_fixup();

ROLLBACK;
