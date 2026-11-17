BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('f148_default_fleet_policy_alignment_v1'));
DO $alignment$
DECLARE r RECORD; roles JSONB; caps JSONB; role_row JSONB; cap TEXT; next_value JSONB; n INT;
BEGIN
 -- Only the default role is aligned. Scoped policy overrides and explicit denies remain authoritative.
 PERFORM 1 FROM public.settings_versions WHERE category='access_control_policy'
  AND scope_type='global' AND scope_id IS NULL AND effective_until IS NULL AND approved_at IS NOT NULL
  ORDER BY id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'F148 approved global policy missing'; END IF;
 SELECT s.cached_value,sv.value,sv.schema_version,sv.approved_at,sv.effective_from,sv.effective_until,
  sv.category,sv.scope_type,sv.scope_id INTO STRICT r
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='access_control_policy' AND s.scope_type='global' AND s.scope_id IS NULL FOR UPDATE OF s;
 IF r.cached_value IS DISTINCT FROM r.value OR r.approved_at IS NULL OR r.effective_until IS NOT NULL
  OR r.effective_from IS NULL OR r.effective_from>clock_timestamp()
  OR r.category IS DISTINCT FROM 'access_control_policy' OR r.scope_type IS DISTINCT FROM 'global' OR r.scope_id IS NOT NULL
  THEN RAISE EXCEPTION 'F148 global policy authority mismatch'; END IF;
 IF jsonb_typeof(r.value->'roles') IS DISTINCT FROM 'array' OR jsonb_typeof(r.value->'capabilities') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'F148 malformed global policy'; END IF;
 SELECT count(*) INTO n FROM jsonb_array_elements(r.value->'roles') x WHERE x->>'key'='ops_admin';
 IF n<>1 THEN RAISE EXCEPTION 'F148 requires exactly one default ops_admin role'; END IF;
 roles:='[]'; caps:=r.value->'capabilities';
 FOREACH cap IN ARRAY ARRAY['fleet.read','fleet.write'] LOOP
  SELECT count(*) INTO n FROM jsonb_array_elements(caps) x WHERE x->>'key'=cap;
  IF n>1 THEN RAISE EXCEPTION 'F148 duplicate fleet capability'; END IF;
  IF n=0 THEN caps:=caps||jsonb_build_array(jsonb_build_object('key',cap,'label',CASE cap WHEN 'fleet.read' THEN 'Fleet Read' ELSE 'Fleet Write' END)); END IF;
 END LOOP;
 FOR role_row IN SELECT value FROM jsonb_array_elements(r.value->'roles') LOOP
  IF role_row->>'key'='ops_admin' THEN
   IF jsonb_typeof(role_row->'capability_keys') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(role_row->'capability_keys') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string')
    THEN RAISE EXCEPTION 'F148 malformed ops_admin capabilities'; END IF;
   FOREACH cap IN ARRAY ARRAY['fleet.read','fleet.write'] LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(role_row->'capability_keys') x WHERE public.capability_key_match(cap,x)) THEN
     role_row:=jsonb_set(role_row,'{capability_keys}',(role_row->'capability_keys')||jsonb_build_array(cap));
    END IF;
   END LOOP;
  END IF;
  roles:=roles||jsonb_build_array(role_row);
 END LOOP;
 next_value:=jsonb_set(jsonb_set(r.value,'{roles}',roles),'{capabilities}',caps);
 IF next_value IS DISTINCT FROM r.value THEN
  PERFORM public.upsert_settings_value_v1('access_control_policy','global',NULL,next_value,r.schema_version,'Align default ops_admin fleet capability contract');
 END IF;
END;
$alignment$;
COMMIT;
