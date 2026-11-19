-- Migration: FieldOps Mobile V2 damage-hold readback
-- Purpose:
--   - make damaged-parcel hold categories row-driven
--   - make the hold queue resolver read real shipment_holds rows
--   - provide a same-screen latest-hold readback after submit_fieldops_damage_hold_v1

BEGIN;
SELECT pg_advisory_lock(hashtext('202605291930_fieldops_mobile_v2_damage_hold_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'mobile_damage_severity_policy',
  'Mobile V2 damaged-parcel hold categories resolved through the settings ladder.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    resource_scope_rel = EXCLUDED.resource_scope_rel,
    updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'mobile_damage_severity_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Mobile V2 Damage Hold Severity Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'required', jsonb_build_array('version', 'severities'),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'severities', jsonb_build_object(
        'type', 'array',
        'minItems', 1,
        'items', jsonb_build_object(
          'type', 'object',
          'required', jsonb_build_array('id', 'label', 'color'),
          'properties', jsonb_build_object(
            'id', jsonb_build_object('type', 'string'),
            'label', jsonb_build_object('type', 'string'),
            'color', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('danger', 'warning', 'info'))
          )
        )
      )
    )
  ),
  'Damage-hold categories and tones for the Mobile V2 damaged parcel sheet.',
  jsonb_build_array(jsonb_build_object(
    'version', 1,
    'severities', jsonb_build_array(
      jsonb_build_object('id', 'crushed', 'label', 'Crushed', 'color', 'danger'),
      jsonb_build_object('id', 'wet', 'label', 'Wet / leaking', 'color', 'danger'),
      jsonb_build_object('id', 'tampered', 'label', 'Open / tampered', 'color', 'danger'),
      jsonb_build_object('id', 'wrong-label', 'label', 'Wrong label', 'color', 'warning'),
      jsonb_build_object('id', 'missing-barcode', 'label', 'Missing barcode', 'color', 'warning')
    )
  )),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active;

WITH seed AS (
  SELECT
    'mobile_damage_severity_policy'::text AS category,
    jsonb_build_object(
      'version', 1,
      'severities', jsonb_build_array(
        jsonb_build_object('id', 'crushed', 'label', 'Crushed', 'color', 'danger'),
        jsonb_build_object('id', 'wet', 'label', 'Wet / leaking', 'color', 'danger'),
        jsonb_build_object('id', 'tampered', 'label', 'Open / tampered', 'color', 'danger'),
        jsonb_build_object('id', 'wrong-label', 'label', 'Wrong label', 'color', 'warning'),
        jsonb_build_object('id', 'missing-barcode', 'label', 'Missing barcode', 'color', 'warning')
      )
    ) AS value
),
inserted_version AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    gen_random_uuid(),
    seed.category,
    'global',
    NULL::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    seed.value,
    1,
    'Mobile V2 damage hold categories global default',
    now(),
    now()
  FROM seed
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = seed.category
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
  )
  RETURNING id, category, value
),
active_version AS (
  SELECT id, category, value FROM inserted_version
  UNION ALL
  SELECT sv.id, sv.category, sv.value
  FROM public.settings_versions sv
  JOIN seed ON seed.category = sv.category
  WHERE sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM inserted_version)
  ORDER BY category
  LIMIT 1
)
INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  gen_random_uuid(),
  category,
  'global',
  NULL::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  id,
  value,
  now()
FROM active_version
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

CREATE OR REPLACE FUNCTION public.resolve_fieldops_hold_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_rows JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_hold_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', h.id,
               'hold_id', h.id,
               'parcel', h.parcel_id::text,
               'parcel_id', h.parcel_id,
               'reason', 'damage',
               'severity_id', h.severity_id,
               'status', h.status,
               'state', h.status,
               'note', h.note,
               'photo_storage_path', h.photo_storage_path,
               'decision_log_id', h.decision_log_id,
               'atMs', floor(extract(epoch from h.created_at) * 1000)::bigint,
               'submitted_at', h.created_at
             )
             ORDER BY h.created_at DESC, h.id DESC
           ),
           '[]'::jsonb
         )
    INTO v_rows
    FROM (
      SELECT *
      FROM public.shipment_holds
      WHERE organization_id = v_org
        AND status = 'open'
      ORDER BY created_at DESC, id DESC
      LIMIT 50
    ) h;

  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_hold_v1(TEXT, JSONB) IS
  'Mobile V2 hold/exception queue backed by public.shipment_holds for same-context damage-hold readback.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_hold_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_hold_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_hold_v1(
  p_active_role TEXT DEFAULT 'loader',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_hold_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_hold_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_hold_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_latest_damage_hold_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_latest JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_latest_damage_hold_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_latest_damage_hold_v1 requires organization context'
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
           'hold_id', h.id,
           'parcel_id', h.parcel_id,
           'severity_id', h.severity_id,
           'state', h.status,
           'status', h.status,
           'note', h.note,
           'photo_storage_path', h.photo_storage_path,
           'decision_log_id', h.decision_log_id,
           'submitted_at', h.created_at
         )
    INTO v_latest
    FROM public.shipment_holds h
   WHERE h.organization_id = v_org
     AND h.reported_by_user_id = v_user_id
   ORDER BY h.created_at DESC, h.id DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'active_role', COALESCE(NULLIF(btrim(p_active_role), ''), 'driver'),
    'latest_damage_hold', v_latest
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_latest_damage_hold_v1(TEXT, JSONB) IS
  'Mobile V2 latest damage-hold readback for the authenticated caller after submit_fieldops_damage_hold_v1.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_latest_damage_hold_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_latest_damage_hold_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_latest_damage_hold_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_latest_damage_hold_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_latest_damage_hold_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_latest_damage_hold_v1(TEXT, JSONB) TO authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.resolve_fieldops_stop_detail_base_v1(uuid,text,jsonb)') IS NULL
     AND to_regprocedure('public.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)') IS NOT NULL THEN
    ALTER FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB)
      RENAME TO resolve_fieldops_stop_detail_base_v1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_stop_detail_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_envelope JSONB;
  v_parcel_count INT;
  v_shipment_id TEXT;
  v_tracking_code TEXT;
  v_service_level TEXT;
  v_scan_done BOOLEAN := FALSE;
  v_damage_hold_open BOOLEAN := FALSE;
BEGIN
  v_envelope := public.resolve_fieldops_stop_detail_base_v1(p_stop_id, p_active_role, p_context);

  v_parcel_count := CASE
    WHEN jsonb_typeof(v_envelope->'parcels') = 'array' THEN jsonb_array_length(v_envelope->'parcels')
    ELSE 0
  END;
  v_shipment_id := NULLIF(v_envelope#>>'{meta,shipment_id}', '');

  IF v_parcel_count = 0 AND v_shipment_id IS NOT NULL THEN
    v_tracking_code := COALESCE(NULLIF(v_envelope->>'trackingCode', ''), NULLIF(v_envelope->>'id', ''), v_shipment_id);
    v_service_level := NULLIF(v_envelope#>>'{meta,service_level}', '');

    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(v_envelope->'proofChecklist') = 'array' THEN v_envelope->'proofChecklist'
          ELSE '[]'::jsonb
        END
      ) AS item
      WHERE item->>'key' = 'scan'
        AND item->>'status' = 'done'
    )
    INTO v_scan_done;

    SELECT EXISTS (
      SELECT 1
      FROM public.shipment_holds h
      WHERE h.organization_id = public.current_user_org_id()
        AND h.parcel_id = v_shipment_id::uuid
        AND h.status = 'open'
    )
    INTO v_damage_hold_open;

    v_envelope := jsonb_set(
      v_envelope,
      '{parcels}',
      jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'id', v_shipment_id,
        'code', v_tracking_code,
        'status', CASE WHEN v_damage_hold_open THEN 'damaged' WHEN v_scan_done THEN 'scanned' ELSE 'pending' END,
        'description', v_service_level,
        'source', 'shipment',
        'shipment_id', v_shipment_id
      ))),
      TRUE
    );

    IF NULLIF(v_envelope->>'parcelsTotalLabel', '') IS NULL THEN
      v_envelope := jsonb_set(v_envelope, '{parcelsTotalLabel}', to_jsonb('1x'::text), TRUE);
    END IF;
  END IF;

  RETURN v_envelope;
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) IS
  'Mobile V2 stop-detail readback wrapper. Preserves the canonical resolver and projects a shipment-level parcel when a real stop has shipment lineage but no shipment_boxes rows, so damage-hold and scan workflows remain backend-backed instead of disabled by empty app-side state.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_stop_detail_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_stop_detail_v1(p_stop_id, p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605291930_fieldops_mobile_v2_damage_hold_readback_v1'));
COMMIT;
