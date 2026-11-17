-- Plan: PLAN-202602-landing-last-mile-content-optimization / Step: S99
-- Purpose:
--   - Restore compatibility for seeded/legacy webhook sources that use
--     provider_type='test' while keeping lookup-column contracts enforced.
--   - Keep integration_type values row-driven and auditable (no trigger bypass).

BEGIN;
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_lookup_definition_id UUID;
BEGIN
  SELECT id
    INTO v_lookup_definition_id
    FROM public.lookup_definitions
   WHERE category = 'integration_type'
   LIMIT 1;

  IF v_lookup_definition_id IS NULL THEN
    RAISE EXCEPTION 'lookup_definitions row missing for category=integration_type';
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    status,
    metadata
  ) VALUES (
    v_lookup_definition_id,
    'test',
    'Test Integration',
    'Compatibility integration type for automated webhook test sources and fixtures.',
    9900,
    FALSE,
    'active',
    jsonb_build_object(
      'compatibility', TRUE,
      'usage', 'test-fixtures'
    )
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    status = 'active',
    retired_at = NULL,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();
END;
$$;

COMMIT;
