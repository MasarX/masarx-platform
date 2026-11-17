-- F808 reporting semantics: a2d9eae / defaults 661fe9db / builder 20a17325.
-- UI consumes this configuration through the existing scope-resolved dashboard RPC.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609060700_dashboard_shipment_reporting_v1'));

DO $reporting$
DECLARE
  v_schema public.schema_registry%ROWTYPE;
  v_schema_version INTEGER;
  v_row RECORD;
  v_next JSONB;
  v_key TEXT;
  v_constraint JSONB;
  v_number NUMERIC;
  v_canonical_schema JSONB := '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"max_sections":{"type":"integer","minimum":1,"maximum":20},"max_items_per_section":{"type":"integer","minimum":1,"maximum":50},"max_actions":{"type":"integer","minimum":1,"maximum":20},"max_metrics":{"type":"integer","minimum":1,"maximum":50}},"required":["max_sections","max_items_per_section","max_actions","max_metrics"]}'::jsonb;
  v_defaults JSONB := '{"enabled":true,"resource":"shipments","status_filter":"status","statuses":[{"key":"delivered","label_key":"delivered"},{"key":"in_transit","label_key":"in_transit"},{"key":"out_for_delivery","label_key":"out_for_delivery"},{"key":"pending","label_key":"pending"},{"key":"exceptions","label_key":"exceptions"},{"key":"cancelled","label_key":"cancelled"},{"key":"returned","label_key":"returned"}],"active_status_keys":["in_transit","out_for_delivery"],"delivered_status_key":"delivered","pending_status_key":"pending","exception_status_key":"exceptions","app_keys":["console"]}'::jsonb;
  v_reporting_schema JSONB := '{"type":["object","null"],"additionalProperties":false,"properties":{"enabled":{"type":"boolean"},"resource":{"type":"string","minLength":1},"status_filter":{"type":"string","minLength":1},"statuses":{"type":"array","minItems":1,"maxItems":50,"items":{"type":"object","additionalProperties":false,"properties":{"key":{"type":"string","minLength":1},"label_key":{"type":"string","pattern":"^[A-Za-z0-9_]+$"}},"required":["key","label_key"]}},"active_status_keys":{"type":"array","minItems":1,"maxItems":50,"uniqueItems":true,"items":{"type":"string","minLength":1}},"delivered_status_key":{"type":"string","minLength":1},"pending_status_key":{"type":"string","minLength":1},"exception_status_key":{"type":"string","minLength":1},"app_keys":{"type":"array","minItems":1,"maxItems":10,"uniqueItems":true,"items":{"type":"string","minLength":1}}},"required":["enabled"],"allOf":[{"if":{"type":"object","required":["enabled"],"properties":{"enabled":{"const":true}}},"then":{"required":["app_keys","resource","status_filter","statuses","active_status_keys","delivered_status_key","pending_status_key","exception_status_key"]}}]}'::jsonb;
BEGIN
  LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_schema FROM public.schema_registry
   WHERE category = 'ui_dashboard_config' AND is_active
   ORDER BY version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(v_schema.schema->'properties') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'active dashboard config schema is missing or invalid';
  END IF;
  SELECT s.id AS settings_id, s.settings_version_id, s.category, s.scope_type,
         s.scope_id, s.scope_hash, s.cached_value, sv.value,
         sv.effective_from, sv.effective_until, sv.approved_at
    INTO v_row
    FROM public.settings s JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
     AND sv.category = s.category AND sv.scope_type = s.scope_type
     AND sv.scope_id IS NOT DISTINCT FROM s.scope_id
   WHERE s.category = 'ui_dashboard_config'
     AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL
   FOR UPDATE OF s, sv;
  IF NOT FOUND OR jsonb_typeof(v_row.value) IS DISTINCT FROM 'object'
     OR v_row.cached_value IS DISTINCT FROM v_row.value
     OR v_row.effective_until IS NOT NULL OR v_row.effective_from > clock_timestamp()
     OR v_row.approved_at IS NULL THEN
    RAISE EXCEPTION 'dashboard config settings pair is missing or inconsistent';
  END IF;
  -- Existing explicit configuration (even malformed) is not migration-owned.
  -- Preserve its settings value, version and pointer; UI validation remains fail-closed.
  IF v_row.value ? 'shipment_reporting' THEN
    RETURN;
  END IF;
  -- No SQL JSON Schema engine exists here. Only the exact existing simple schema
  -- has a proven additive extension; custom cross-property/ref/report schemas fail
  -- closed without modifying their content or publishing an unvalidated default.
  IF v_schema.schema IS DISTINCT FROM v_canonical_schema THEN
    RAISE EXCEPTION 'custom dashboard schema requires supported validation before reporting seed';
  END IF;
  -- Validate actual root values against the four proven canonical integer constraints.
  -- A cache-equal approved pointer alone does not prove its payload is schema-valid.
  FOR v_key, v_constraint IN
    SELECT key, value FROM jsonb_each(v_canonical_schema->'properties')
  LOOP
    IF jsonb_typeof(v_row.value->v_key) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'dashboard setting % must be a required integer', v_key;
    END IF;
    v_number := (v_row.value->>v_key)::numeric;
    IF v_number <> trunc(v_number)
       OR v_number < (v_constraint->>'minimum')::numeric
       OR v_number > (v_constraint->>'maximum')::numeric THEN
      RAISE EXCEPTION 'dashboard setting % violates its canonical integer bounds', v_key;
    END IF;
  END LOOP;
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_schema_version
    FROM public.schema_registry WHERE category = 'ui_dashboard_config';
  INSERT INTO public.schema_registry(category, version, schema, description, examples, is_active)
  VALUES ('ui_dashboard_config', v_schema_version,
    jsonb_set(v_schema.schema, '{properties,shipment_reporting}',
      COALESCE(v_schema.schema#>'{properties,shipment_reporting}', v_reporting_schema), TRUE),
    'Dashboard with optional scoped shipment reporting', v_schema.examples, TRUE);
  UPDATE public.schema_registry SET is_active = FALSE
   WHERE category = 'ui_dashboard_config' AND version <> v_schema_version AND is_active;

  v_next := jsonb_set(v_row.value, '{shipment_reporting}', v_defaults, TRUE);
  -- JSON Schema is validated by the existing JS settings-upsert helper in source
  -- qualification. No PostgreSQL validator is assumed for arbitrary custom schemas.
  IF jsonb_typeof(v_next->'shipment_reporting') IS DISTINCT FROM 'object'
     OR v_next#>'{shipment_reporting,app_keys}' IS DISTINCT FROM '["console"]'::jsonb
     OR jsonb_typeof(v_next#>'{shipment_reporting,statuses}') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_next#>'{shipment_reporting,statuses}') <> 7 THEN
    RAISE EXCEPTION 'invalid introduced shipment reporting defaults';
  END IF;
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
      v_next, v_schema_version, 'Restore F808 reporting without overriding explicit dashboard policy',
      clock_timestamp(), clock_timestamp()
    FROM closed RETURNING id, value
  )
  UPDATE public.settings s
     SET settings_version_id = inserted.id, cached_value = inserted.value, last_updated = clock_timestamp()
    FROM inserted
   WHERE s.id = v_row.settings_id AND s.settings_version_id = v_row.settings_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dashboard reporting promotion lost settings pointer CAS';
  END IF;
  DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_dashboard_config:%';
END;
$reporting$;
COMMIT;
