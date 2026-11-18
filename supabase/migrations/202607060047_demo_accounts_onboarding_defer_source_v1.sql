-- Migration: Demo account onboarding defer source
-- Purpose:
--   Demo account provisioning creates the tenant, then creates canonical
--   clients/senders before running the tenant bootstrap. Register that source
--   as an explicit organization insert defer source without weakening plugin
--   activation source-binding checks.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607060047_demo_accounts_onboarding_defer_source_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_defer_sources JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'saas_onboarding_policy global settings missing';
  END IF;

  v_defer_sources := COALESCE(
    v_current #> ARRAY['organization_insert_trigger', 'defer_sources'],
    '[]'::jsonb
  );

  IF jsonb_typeof(v_defer_sources) <> 'array' THEN
    v_defer_sources := '[]'::jsonb;
  END IF;

  IF NOT (v_defer_sources ? 'provision_demo_accounts_v1') THEN
    v_defer_sources := v_defer_sources || jsonb_build_array('provision_demo_accounts_v1');
  END IF;

  v_next := v_current;
  v_next := jsonb_set(
    v_next,
    ARRAY['organization_insert_trigger'],
    COALESCE(v_next->'organization_insert_trigger', '{}'::jsonb),
    TRUE
  );
  v_next := jsonb_set(
    v_next,
    ARRAY['organization_insert_trigger', 'defer_sources'],
    v_defer_sources,
    TRUE
  );

  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    public.get_root_scope_type_key_v1(),
    NULL,
    v_next,
    1,
    'Allow demo account provisioning to defer organization insert bootstrap until sender context exists'
  );
END;
$do$;

DO $assert$
DECLARE
  v_sources JSONB := COALESCE(
    public.resolve_saas_onboarding_policy_v1()
      #> ARRAY['organization_insert_trigger', 'defer_sources'],
    '[]'::jsonb
  );
BEGIN
  IF jsonb_typeof(v_sources) <> 'array' OR NOT (v_sources ? 'provision_demo_accounts_v1') THEN
    RAISE EXCEPTION 'demo account organization insert defer source was not registered';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202607060047_demo_accounts_onboarding_defer_source_v1'));

COMMIT;
