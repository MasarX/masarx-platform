BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Use the existing scan type and versioned lookup catalogs.
INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('stop_scan_manual_entry_reason', 'Reasons for entering a stop parcel barcode manually', 'dispatch', 'tier_1', FALSE);

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order)
SELECT ld.id, reason.code, reason.label, reason.description, reason.sort_order
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('scanner_unavailable', 'Scanner unavailable', 'The scanner is unavailable or cannot capture a readable label', 10),
  ('barcode_unreadable', 'Barcode unreadable', 'The barcode cannot be scanned but its printed value can be read', 20)
) AS reason(code, label, description, sort_order)
WHERE ld.category = 'stop_scan_manual_entry_reason';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order)
SELECT id, 'stop_parcel', 'Stop parcel', 'Confirms a parcel at an assigned route stop', 85
FROM public.lookup_definitions WHERE category = 'scan_type';

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'scan_policy' AND version = 2) THEN
    RAISE EXCEPTION 'scan_policy schema v2 missing; cannot create v3';
  END IF;
END;
$migration$;

-- Older FieldOps builds reject any unfamiliar value in scan_input_modes.
INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
SELECT category, 3,
  jsonb_set(schema, '{properties,manual_entry}',
    '{
      "type":"object", "additionalProperties":false, "required":["enabled","reason_codes"],
      "properties":{
        "enabled":{"type":"boolean"},
        "reason_codes":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","minLength":1}}
      }
    }'::jsonb),
  'Scan policy v3: scoped opt-in for manual entry of a stop parcel barcode.',
  (SELECT jsonb_agg(e.value || jsonb_build_object('version', 3, 'manual_entry', jsonb_build_object(
    'enabled', FALSE, 'reason_codes', (
      SELECT jsonb_agg(lv.value ORDER BY lv.sort_order)
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'stop_scan_manual_entry_reason'
    ))))
   FROM jsonb_array_elements(examples) AS e(value)),
  TRUE
FROM public.schema_registry WHERE category = 'scan_policy' AND version = 2;

DO $migration$
DECLARE
  definition text := replace(pg_get_functiondef('public.record_scan_event_v1(jsonb)'::regprocedure), E'\r\n', E'\n');
  policy_anchor constant text := '  -- Resolve ingest/scan policies (ladder-resolved; branch-aware via resource_id=branch_id when available).';
  dedupe_query constant text := $sql$  SELECT d.scan_event_id
    INTO v_existing_scan_event_id$sql$;
  parse_stop constant text := $sql$  BEGIN v_stop_id := NULLIF(v_in->>'route_stop_id', '')::uuid; EXCEPTION WHEN others THEN v_stop_id := NULL; END;$sql$;
  early_replay constant text := '    RETURN QUERY SELECT v_existing_scan_event_id, FALSE;';
  parallel_replay constant text := '    RETURN QUERY SELECT v_id, FALSE;';
  stop_branch constant text := $sql$  IF v_scan_type = 'stop_parcel' THEN
    SELECT rr.branch_id INTO v_branch_id
    FROM public.route_runs rr
    WHERE rr.id = v_run_id AND rr.organization_id = v_org
      AND (v_branch_id IS NULL OR v_branch_id IS NOT DISTINCT FROM rr.branch_id);

    IF NOT FOUND OR v_stop_id IS NULL THEN
      RAISE EXCEPTION 'Stop parcel scan requires a matching route stop and branch' USING ERRCODE = '42501';
    END IF;
  END IF;

$sql$;
  replay_guard constant text := $sql$    IF lower(btrim(v_in->>'scan_type')) = 'stop_parcel' AND NOT EXISTS (
      SELECT 1 FROM public.scan_events se
      WHERE se.organization_id = v_org AND se.id = %s
        AND se.actor_user_id = v_user AND se.scan_type = 'stop_parcel'
        AND se.route_stop_id = v_stop_id
        AND se.barcode = btrim(v_in->>'barcode')
        AND se.metadata->'scan_input_mode' IS NOT DISTINCT FROM v_in#>'{metadata,scan_input_mode}'
        AND se.metadata->'scan_reason_code' IS NOT DISTINCT FROM v_in#>'{metadata,scan_reason_code}'
        AND se.metadata->'scan_reason_note' IS NOT DISTINCT FROM v_in#>'{metadata,scan_reason_note}'
    ) THEN
      RAISE EXCEPTION 'Stop parcel scan retry does not match the recorded scan' USING ERRCODE = '42501';
    END IF;
$sql$;
BEGIN
  IF cardinality(string_to_array(definition, policy_anchor)) <> 2
     OR cardinality(string_to_array(definition, dedupe_query)) <> 2
     OR cardinality(string_to_array(definition, parse_stop)) <> 2
     OR cardinality(string_to_array(definition, early_replay)) <> 2
     OR cardinality(string_to_array(definition, parallel_replay)) <> 2 THEN
    RAISE EXCEPTION 'Unexpected record_scan_event_v1 definition while adding stop parcel scans';
  END IF;
  definition := replace(definition, parse_stop || E'\n', '');
  definition := replace(definition, dedupe_query, parse_stop || E'\n\n' || dedupe_query);
  definition := replace(definition, policy_anchor, stop_branch || policy_anchor);
  definition := replace(definition, early_replay, format(replay_guard, 'v_existing_scan_event_id') || early_replay);
  EXECUTE replace(definition, parallel_replay, format(replay_guard, 'v_id') || parallel_replay);
END;
$migration$;

DO $migration$
DECLARE
  definition text := replace(pg_get_functiondef('public.enforce_scan_input_mode_policy_v1()'::regprocedure), E'\r\n', E'\n');
  start_anchor constant text := $sql$  v_mode TEXT;
BEGIN
  IF NOT (COALESCE(NEW.metadata, '{}'::jsonb) ? 'scan_input_mode') THEN$sql$;
  policy_anchor constant text := $sql$  SELECT policy.value->'scan_input_modes' INTO v_modes$sql$;
  mode_anchor constant text := $sql$  IF jsonb_typeof(NEW.metadata->'scan_input_mode') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v_modes) IS DISTINCT FROM 'array'$sql$;
  stop_scope constant text := $sql$  v_mode TEXT;
  v_policy RECORD;
  v_tracking_number TEXT;
  v_reason_id UUID;
BEGIN
  IF NEW.scan_type = 'stop_parcel' THEN
    SELECT sh.tracking_number INTO v_tracking_number
    FROM public.route_stops rs
    JOIN public.route_runs rr ON rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id
    JOIN public.shipments sh
      ON sh.id = rs.shipment_id AND sh.client_id = rs.client_id AND sh.organization_id = rs.organization_id
    WHERE rs.id = NEW.route_stop_id AND rs.organization_id = NEW.organization_id
      AND rs.route_run_id = NEW.route_run_id AND rs.client_id = NEW.client_id
      AND rs.shipment_id = NEW.shipment_id
      AND rr.branch_id IS NOT DISTINCT FROM NEW.branch_id
      AND rr.driver_user_id = NEW.actor_user_id AND rr.driver_user_id = auth.uid()
      AND public.user_has_permission_v1('tasks.complete', rs.organization_id)
    FOR SHARE OF rs, rr;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stop parcel scan requires access to the assigned stop' USING ERRCODE = '42501';
    END IF;

    -- Fall back to the shipment tracking number when no box has a non-NULL barcode.
    IF NOT COALESCE((
      SELECT COALESCE(bool_or(b.barcode = NEW.barcode), NEW.barcode = v_tracking_number)
      FROM public.shipment_boxes b
      WHERE b.shipment_id = NEW.shipment_id AND b.client_id = NEW.client_id
        AND b.organization_id = NEW.organization_id
    ), FALSE) THEN
      RAISE EXCEPTION 'Barcode does not match a parcel at this stop' USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(NEW.metadata->'scan_input_mode') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Stop parcel scan requires an input mode' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT (COALESCE(NEW.metadata, '{}'::jsonb) ? 'scan_input_mode') THEN$sql$;
  manual_gate constant text := $sql$  v_modes := v_policy.value->'scan_input_modes';

  IF v_mode = 'manual_entry' THEN
    IF NEW.scan_type <> 'stop_parcel'
       OR v_policy.value#>'{manual_entry,enabled}' IS DISTINCT FROM 'true'::jsonb
       OR NOT EXISTS (
         SELECT 1 FROM public.settings_versions sv
         WHERE sv.id = v_policy.settings_version_id AND sv.schema_version >= 3
       ) THEN
      RAISE EXCEPTION 'Manual entry is unavailable for this scan under the resolved scan policy' USING ERRCODE = '42501';
    END IF;

    SELECT lv.id INTO v_reason_id
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'stop_scan_manual_entry_reason' AND lv.organization_id IS NULL
      AND lv.value = NEW.metadata->>'scan_reason_code' AND lv.status = 'active'
      AND jsonb_typeof(v_policy.value#>'{manual_entry,reason_codes}') = 'array'
      AND (v_policy.value#>'{manual_entry,reason_codes}') ? lv.value
      AND (lv.effective_from IS NULL OR lv.effective_from <= now())
      AND (lv.effective_until IS NULL OR lv.effective_until > now());

    IF jsonb_typeof(NEW.metadata->'scan_reason_code') IS DISTINCT FROM 'string' OR v_reason_id IS NULL THEN
      RAISE EXCEPTION 'Select an active manual-entry reason for the stop parcel scan'
        USING ERRCODE = '23514',
          DETAIL = format('scan_reason_code=%s', COALESCE(NEW.metadata->'scan_reason_code', 'null'::jsonb));
    END IF;
    IF NEW.metadata ? 'scan_reason_note' AND jsonb_typeof(NEW.metadata->'scan_reason_note') <> 'string' THEN
      RAISE EXCEPTION 'Manual-entry note must be text when provided' USING ERRCODE = '23514';
    END IF;

    NEW.metadata := NEW.metadata || jsonb_build_object(
      'scan_reason_lookup_value_id', v_reason_id,
      'scan_policy_settings_version_id', v_policy.settings_version_id
    );
    RETURN NEW;
  END IF;

$sql$;
BEGIN
  IF cardinality(string_to_array(definition, start_anchor)) <> 2
     OR cardinality(string_to_array(definition, policy_anchor)) <> 2
     OR cardinality(string_to_array(definition, mode_anchor)) <> 2 THEN
    RAISE EXCEPTION 'Unexpected scan input mode trigger definition while adding manual entry';
  END IF;
  definition := replace(definition, start_anchor, stop_scope);
  definition := replace(definition, policy_anchor, '  SELECT policy.* INTO v_policy');
  EXECUTE replace(definition, mode_anchor, manual_gate || mode_anchor);
END;
$migration$;

DO $migration$
DECLARE
  definition text := replace(pg_get_functiondef('public.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)'::regprocedure), E'\r\n', E'\n');
  cod_query constant text := $sql$  SELECT
    s.cod_amount,$sql$;
  scan_readback constant text := $sql$  -- The base resolver authorizes the stop first. Route visibility also protects
  -- the new ledger projection independently of the caller-supplied active role.
  IF jsonb_typeof(v_envelope->'parcels') = 'array' THEN
    WITH confirmed AS (
      SELECT DISTINCT se.barcode
      FROM public.route_stops rs
      JOIN public.route_runs rr ON rr.id = rs.route_run_id AND rr.organization_id = rs.organization_id
      JOIN public.scan_events se
        ON se.route_stop_id = rs.id AND se.organization_id = rs.organization_id
        AND se.route_run_id = rs.route_run_id AND se.client_id = rs.client_id AND se.shipment_id = rs.shipment_id
      WHERE rs.id = p_stop_id AND se.scan_type = 'stop_parcel'
        AND public.route_run_actor_can_read_v1(rs.organization_id, rr.id, rr.driver_user_id)
    )
    SELECT jsonb_set(v_envelope, '{parcels}', COALESCE(jsonb_agg(
      CASE WHEN c.barcode IS NOT NULL AND parcel.value->>'status' = 'pending'
        THEN parcel.value || '{"status":"scanned"}'::jsonb
        ELSE parcel.value
      END ORDER BY parcel.ordinality), '[]'::jsonb), FALSE)
    INTO v_envelope
    FROM jsonb_array_elements(v_envelope->'parcels') WITH ORDINALITY AS parcel(value, ordinality)
    LEFT JOIN confirmed c ON c.barcode = parcel.value->>'code';
  END IF;

$sql$;
BEGIN
  IF cardinality(string_to_array(definition, cod_query)) <> 2 THEN
    RAISE EXCEPTION 'Unexpected stop-detail definition while adding confirmed parcel scans';
  END IF;
  EXECUTE replace(definition, cod_query, scan_readback || cod_query);
END;
$migration$;

REVOKE ALL ON FUNCTION public.enforce_scan_input_mode_policy_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_scan_input_mode_policy_v1() TO service_role;

COMMIT;
