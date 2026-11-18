-- F774: source-selected timing, never an onboarding bypass.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609070100_organization_onboarding_deferred_completion_v1'));

DO $policy$
DECLARE
  v_schema public.schema_registry%ROWTYPE;
  v_schema_version INTEGER;
  v_row RECORD;
  v_next JSONB;
  v_trigger JSONB;
  v_sources JSONB;
  v_trigger_schema JSONB := '{"type":"object","additionalProperties":true,"properties":{"defer_sources":{"type":"array","uniqueItems":true,"items":{"type":"string","minLength":1}}}}'::jsonb;
BEGIN
  LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_schema FROM public.schema_registry
   WHERE category = 'saas_onboarding_policy' AND is_active
   ORDER BY version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_schema.schema->'properties') IS DISTINCT FROM 'object'
     OR (v_schema.schema#>'{properties,organization_insert_trigger}' IS NOT NULL
       AND jsonb_typeof(v_schema.schema#>'{properties,organization_insert_trigger}') IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'active onboarding policy schema is missing or invalid';
  END IF;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_schema_version
    FROM public.schema_registry WHERE category = 'saas_onboarding_policy';
  INSERT INTO public.schema_registry(category, version, schema, description, examples, is_active)
  VALUES ('saas_onboarding_policy', v_schema_version,
    jsonb_set(v_schema.schema, '{properties,organization_insert_trigger}',
      public.jsonb_deep_merge(
        v_trigger_schema,
        COALESCE(v_schema.schema#>'{properties,organization_insert_trigger}', '{}'::jsonb)), TRUE),
    'Onboarding timing sources with mandatory transaction completion', v_schema.examples, TRUE);
  UPDATE public.schema_registry SET is_active = FALSE
   WHERE category = 'saas_onboarding_policy' AND version <> v_schema_version AND is_active;

  SELECT s.id AS settings_id, s.settings_version_id, s.category, s.scope_type,
         s.scope_id, s.scope_hash, s.cached_value, sv.value
    INTO v_row FROM public.settings s JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL
   FOR UPDATE OF s, sv;
  IF NOT FOUND OR jsonb_typeof(v_row.value) IS DISTINCT FROM 'object'
     OR v_row.cached_value IS DISTINCT FROM v_row.value THEN
    RAISE EXCEPTION 'onboarding policy settings pair is missing or inconsistent';
  END IF;
  v_trigger := COALESCE(v_row.value->'organization_insert_trigger', '{}'::jsonb);
  v_sources := COALESCE(v_trigger->'defer_sources', '[]'::jsonb);
  IF jsonb_typeof(v_trigger) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_sources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'onboarding timing policy is malformed';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_sources) item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
       OR NULLIF(btrim(item#>>'{}'), '') IS NULL) THEN
    RAISE EXCEPTION 'onboarding timing sources must be nonempty strings';
  END IF;
  IF NOT (v_sources ? 'provision_demo_accounts_v1') THEN
    v_sources := v_sources || jsonb_build_array('provision_demo_accounts_v1');
  END IF;
  v_next := jsonb_set(v_row.value, '{organization_insert_trigger}',
    jsonb_set(v_trigger, '{defer_sources}', v_sources, TRUE), TRUE);
  WITH closed AS (
    UPDATE public.settings_versions
       SET effective_until = GREATEST(clock_timestamp(), effective_from + INTERVAL '1 microsecond'),
           updated_at = clock_timestamp()
     WHERE id = v_row.settings_version_id AND scope_hash = v_row.scope_hash AND effective_until IS NULL
    RETURNING id
  ), inserted AS (
    INSERT INTO public.settings_versions(
      id, category, scope_type, scope_id, scope_hash, version, value,
      schema_version, change_reason, approved_at, effective_from)
    SELECT gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id, v_row.scope_hash,
      (SELECT COALESCE(MAX(candidate.version), 0) + 1 FROM public.settings_versions candidate
        WHERE candidate.category = v_row.category AND candidate.scope_type = v_row.scope_type
          AND candidate.scope_hash = v_row.scope_hash),
      v_next, v_schema_version, 'Restore demo onboarding timing with mandatory deferred completion',
      clock_timestamp(), clock_timestamp()
    FROM closed RETURNING id, value
  )
  UPDATE public.settings s
     SET settings_version_id = inserted.id, cached_value = inserted.value, last_updated = clock_timestamp()
    FROM inserted
   WHERE s.id = v_row.settings_id AND s.settings_version_id = v_row.settings_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'onboarding policy promotion lost settings pointer CAS';
  END IF;
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'saas_onboarding_policy:%';
END;
$policy$;

-- Eligibility is read-only timing policy, not permission to mutate an organization.
-- The existing INSERT/UPDATE grants and RLS remain authoritative.
CREATE OR REPLACE FUNCTION public.organization_onboarding_deferred_v1()
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_source TEXT := NULLIF(current_setting('app.organization_onboarding_source', TRUE), '');
  v_sources JSONB;
BEGIN
  IF v_source IS NULL THEN RETURN FALSE; END IF;
  v_sources := COALESCE(public.resolve_saas_onboarding_policy_v1()
    #> '{organization_insert_trigger,defer_sources}', '[]'::jsonb);
  IF jsonb_typeof(v_sources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'onboarding timing sources must be an array';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_sources) item
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
       OR NULLIF(btrim(item#>>'{}'), '') IS NULL) THEN
    RAISE EXCEPTION 'onboarding timing sources must be nonempty strings';
  END IF;
  RETURN v_sources ? v_source;
END;
$function$;
REVOKE ALL ON FUNCTION public.organization_onboarding_deferred_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_onboarding_deferred_v1() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_bootstrap_tenant_onboarding_v1()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF public.organization_onboarding_deferred_v1() THEN RETURN NEW; END IF;
  PERFORM public.bootstrap_tenant_onboarding_v1(NEW.id, 'trigger:organizations.insert');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_complete_deferred_tenant_onboarding_v1()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  -- Do not recheck the source here: restoration must never cancel queued work.
  v_result := public.bootstrap_tenant_onboarding_v1(NEW.id, 'trigger:organizations.deferred');
  IF (v_result->>'ok') IS DISTINCT FROM 'true'
     OR (v_result->>'organization_id') IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'deferred tenant onboarding did not return an exact successful receipt';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.trigger_complete_deferred_tenant_onboarding_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_complete_deferred_tenant_onboarding_v1() TO service_role;

CREATE CONSTRAINT TRIGGER trg_organizations_deferred_onboarding_v1
AFTER INSERT OR UPDATE ON public.organizations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (public.organization_onboarding_deferred_v1())
EXECUTE FUNCTION public.trigger_complete_deferred_tenant_onboarding_v1();

COMMENT ON FUNCTION public.organization_onboarding_deferred_v1() IS
  'Read-only source timing eligibility. This grants no mutation authority and never bypasses mandatory canonical bootstrap at transaction completion.';
COMMIT;
