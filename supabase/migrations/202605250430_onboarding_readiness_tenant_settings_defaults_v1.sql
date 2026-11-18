-- Migration: Console V2 onboarding readiness tenant settings defaults
-- Purpose: Materialize newly required tenant-scope defaults for existing
-- organizations so first-tenant readiness does not stay blocked after a
-- category is added to the required-default registry.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605250430_onboarding_readiness_tenant_settings_defaults_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

DO $$
DECLARE
  v_category TEXT;
  v_org RECORD;
  v_source_row RECORD;
  v_schema_version INT;
BEGIN
  FOR v_category IN
    SELECT category
    FROM (
      VALUES
        ('support_policy'),
        ('workflow_binding_defaults')
    ) AS required(category)
  LOOP
    SELECT *
      INTO v_source_row
      FROM public.resolve_settings_row(v_category, 'global', NULL::uuid)
      LIMIT 1;

    IF v_source_row.settings_version_id IS NULL OR v_source_row.value IS NULL THEN
      RAISE EXCEPTION 'Cannot materialize tenant defaults for %, missing global default', v_category
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(sv.schema_version, sr.version, 1)
      INTO v_schema_version
      FROM public.settings_versions sv
      LEFT JOIN LATERAL (
        SELECT x.version
        FROM public.schema_registry x
        WHERE x.category = v_category
          AND x.is_active = TRUE
        ORDER BY x.version DESC
        LIMIT 1
      ) sr ON TRUE
      WHERE sv.id = v_source_row.settings_version_id
      LIMIT 1;

    FOR v_org IN
      SELECT o.id
      FROM public.organizations o
      WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
        AND NOT EXISTS (
        SELECT 1
        FROM public.settings s
        WHERE s.category = v_category
          AND s.scope_type = 'tenant'
          AND s.scope_id = o.id
      )
      ORDER BY o.id
    LOOP
      PERFORM *
      FROM public.upsert_settings_value_v1(
        v_category,
        'tenant',
        v_org.id,
        v_source_row.value,
        COALESCE(v_schema_version, 1),
        format(
          'Onboarding readiness tenant default sync for %s/%s',
          v_category,
          v_org.id
        )
      );
    END LOOP;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605250430_onboarding_readiness_tenant_settings_defaults_v1'));

COMMIT;
