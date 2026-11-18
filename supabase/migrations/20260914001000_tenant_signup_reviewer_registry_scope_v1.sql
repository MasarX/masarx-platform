-- Keep the raw signup review queue platform-only through the shared registry guard.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20260914001000_tenant_signup_reviewer_registry_scope_v1'));

DO $registry$
DECLARE
  r RECORD;
  v_count INTEGER;
  v_resources JSONB;
  v_next JSONB;
BEGIN
  PERFORM 1 FROM public.settings_versions
   WHERE category = 'ui_read_registry' AND effective_until IS NULL AND approved_at IS NOT NULL
   ORDER BY id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Approved ui_read_registry baseline missing'; END IF;

  FOR r IN
    SELECT s.scope_type, s.scope_id, s.cached_value, sv.value, sv.schema_version,
           sv.category AS version_category, sv.scope_type AS version_scope_type,
           sv.scope_id AS version_scope_id, sv.approved_at, sv.effective_until
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
     ORDER BY s.id FOR UPDATE OF s
  LOOP
    IF r.cached_value IS DISTINCT FROM r.value OR r.approved_at IS NULL
       OR r.effective_until IS NOT NULL OR r.version_category IS DISTINCT FROM 'ui_read_registry'
       OR r.version_scope_type IS DISTINCT FROM r.scope_type
       OR r.version_scope_id IS DISTINCT FROM r.scope_id
       OR jsonb_typeof(r.value->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry authority mismatch';
    END IF;

    SELECT count(*) INTO v_count FROM jsonb_array_elements(r.value->'resources') e
     WHERE e->>'key' = 'tenant_signup_requests';
    IF v_count > 1 OR (r.scope_type = 'global' AND v_count <> 1) THEN
      RAISE EXCEPTION 'Invalid tenant signup reviewer registry count: %', v_count;
    END IF;
    IF v_count = 0 THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.value->'resources') e
       WHERE e->>'key' = 'tenant_signup_requests'
         AND (e->>'relation' IS DISTINCT FROM 'public.tenant_signup_requests'
              OR e->>'capability_read' IS DISTINCT FROM 'tenant_signup_requests.read')
    ) THEN RAISE EXCEPTION 'Unexpected tenant signup reviewer registry contract'; END IF;

    SELECT jsonb_agg(
      CASE WHEN e->>'key' = 'tenant_signup_requests'
        THEN e || '{"read_scope_types":["platform"]}'::jsonb ELSE e END ORDER BY n)
      INTO v_resources
      FROM jsonb_array_elements(r.value->'resources') WITH ORDINALITY x(e,n);
    v_next := jsonb_set(r.value, '{resources}', v_resources);
    IF v_next IS DISTINCT FROM r.value THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', r.scope_type, r.scope_id, v_next, r.schema_version,
        'Restrict tenant signup reviewer reads to platform scope');
    END IF;
  END LOOP;
END;
$registry$;
COMMIT;
