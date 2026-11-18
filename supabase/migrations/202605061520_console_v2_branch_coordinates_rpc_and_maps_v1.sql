-- Console V2 branch coordinate capture/readiness.
--
-- Purpose:
--   Keep branch/hub latitude + longitude capture canonical for first-tenant
--   setup. Branch create/update RPCs now persist p_args.coordinates into the
--   PostGIS branches.coordinates column, and live map projections expose lat/lng
--   so tracking/zones map consumers do not fall into missing-location after
--   normal branch setup.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605061520_console_v2_branch_coordinates_rpc_and_maps_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_coordinates_from_payload_v1(p_payload JSONB)
RETURNS geography
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_raw JSONB;
  v_raw_type TEXT;
  v_lat_text TEXT;
  v_lng_text TEXT;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_wkt TEXT;
  v_geog geography;
BEGIN
  IF p_payload IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_payload ? 'coordinates' THEN
    v_raw := p_payload->'coordinates';
    IF v_raw IS NULL OR v_raw = 'null'::jsonb THEN
      RETURN NULL;
    END IF;

    v_raw_type := jsonb_typeof(v_raw);
    IF v_raw_type = 'object' THEN
      v_lat_text := COALESCE(
        NULLIF(btrim(v_raw->>'lat'), ''),
        NULLIF(btrim(v_raw->>'latitude'), '')
      );
      v_lng_text := COALESCE(
        NULLIF(btrim(v_raw->>'lng'), ''),
        NULLIF(btrim(v_raw->>'longitude'), '')
      );
    ELSIF v_raw_type = 'string' THEN
      v_wkt := NULLIF(btrim(p_payload->>'coordinates'), '');
      IF v_wkt IS NULL THEN
        RETURN NULL;
      END IF;
      v_geog := ST_GeogFromText(v_wkt);
      IF GeometryType(v_geog::geometry) <> 'POINT' THEN
        RAISE EXCEPTION 'branch coordinates WKT must be a POINT'
          USING ERRCODE = '22023';
      END IF;
      RETURN v_geog;
    ELSE
      RAISE EXCEPTION 'branch coordinates must be a JSON object, WKT string, or null'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_lat_text := COALESCE(
      NULLIF(btrim(p_payload->>'lat'), ''),
      NULLIF(btrim(p_payload->>'latitude'), '')
    );
    v_lng_text := COALESCE(
      NULLIF(btrim(p_payload->>'lng'), ''),
      NULLIF(btrim(p_payload->>'longitude'), '')
    );
  END IF;

  IF v_lat_text IS NULL AND v_lng_text IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_lat_text IS NULL OR v_lng_text IS NULL THEN
    RAISE EXCEPTION 'branch coordinates require both latitude and longitude'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_lat := v_lat_text::DOUBLE PRECISION;
    v_lng := v_lng_text::DOUBLE PRECISION;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'branch coordinates must be numeric latitude/longitude'
        USING ERRCODE = '22023';
  END;

  IF v_lat < -90 OR v_lat > 90 OR v_lng < -180 OR v_lng > 180 THEN
    RAISE EXCEPTION 'branch coordinates outside valid latitude/longitude bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography;
END;
$$;

REVOKE ALL ON FUNCTION public.branch_coordinates_from_payload_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_coordinates_from_payload_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_coordinates_from_payload_v1(JSONB) IS
  'Normalizes branch coordinate RPC payloads into the canonical branches.coordinates PostGIS point.';

CREATE OR REPLACE FUNCTION public.branch_create_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org_id UUID := public.current_user_org_id();
  v_target_org UUID := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_caller_org_id);
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_code TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'code', '')), ''));
  v_branch_type TEXT := NULLIF(btrim(COALESCE(p_args->>'branch_type', '')), '');
  v_timezone TEXT := NULLIF(btrim(COALESCE(p_args->>'timezone', '')), '');
  v_address JSONB := COALESCE(p_args->'address', NULL);
  v_address_text TEXT := NULLIF(btrim(COALESCE(p_args->>'address', '')), '');
  v_operating_hours JSONB := COALESCE(p_args->'operating_hours', NULL);
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_coordinates geography := public.branch_coordinates_from_payload_v1(p_args);
  v_is_active BOOLEAN := COALESCE((p_args->>'is_active')::boolean, TRUE);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_create_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_target_org);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'branch_create_v1 requires name' USING ERRCODE = '23502';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'branch_create_v1 requires organization_id (caller has no scope)'
      USING ERRCODE = '23502';
  END IF;

  IF v_caller_org_id IS NOT NULL
     AND v_target_org <> v_caller_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'branch_create_v1 organization % outside tenant scope', v_target_org
      USING ERRCODE = '42501';
  END IF;

  IF v_code IS NULL THEN
    v_code := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
    v_code := regexp_replace(v_code, '(^-|-$)', '', 'g');
    IF v_code IS NULL OR v_code = '' THEN
      v_code := 'branch';
    END IF;
    WHILE EXISTS (SELECT 1 FROM public.branches b WHERE b.organization_id = v_target_org AND b.code = v_code) LOOP
      v_code := v_code || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4);
    END LOOP;
  END IF;

  IF v_address IS NULL AND v_address_text IS NOT NULL THEN
    v_address := jsonb_build_object('formatted', v_address_text);
  END IF;

  INSERT INTO public.branches (
    organization_id, code, name, branch_type, timezone,
    operating_hours, address, coordinates, is_active, metadata
  ) VALUES (
    v_target_org, v_code, v_name, v_branch_type, v_timezone,
    v_operating_hours, v_address, v_coordinates, v_is_active, v_metadata
  ) RETURNING id INTO v_branch_id;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_target_org, 'branch.created', 'branch', v_branch_id, v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'branch_id', v_branch_id,
      'organization_id', v_target_org,
      'name', v_name,
      'code', v_code,
      'branch_type', v_branch_type,
      'timezone', v_timezone,
      'coordinates_present', v_coordinates IS NOT NULL
    )),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_target_org,
    p_decision_category := 'branches.create',
    p_resource_type := 'branch',
    p_resource_id := v_branch_id,
    p_decision_point := 'branch_create_v1',
    p_decision_outcome := 'created',
    p_performed_by_system := 'branch_create_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'name', v_name,
      'code', v_code,
      'branch_type', v_branch_type,
      'timezone', v_timezone,
      'is_active', v_is_active,
      'coordinates_present', v_coordinates IS NOT NULL
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_id', v_branch_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_create_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_create_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_create_v1(JSONB) IS
  'NETWORK canonical write RPC: insert public.branches row including optional coordinates + decision_log + domain_event. Capability: branches.write.';

CREATE OR REPLACE FUNCTION public.branch_update_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_branch public.branches%ROWTYPE;
  v_patch JSONB := COALESCE(p_args->'patch', '{}'::jsonb);
  v_coordinates_present BOOLEAN := v_patch ? 'coordinates'
    OR v_patch ? 'lat'
    OR v_patch ? 'lng'
    OR v_patch ? 'latitude'
    OR v_patch ? 'longitude';
  v_coordinates geography;
  v_changed JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_update_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_branch_id := NULLIF(p_args->>'branch_id', '')::uuid;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'branch_update_v1 requires branch_id' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_branch_id FOR UPDATE;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'branch_update_v1 branch % not found', v_branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'branch_update_v1 branch % outside tenant scope', v_branch_id USING ERRCODE = '42501';
  END IF;

  IF v_coordinates_present THEN
    v_coordinates := public.branch_coordinates_from_payload_v1(v_patch);
  END IF;

  UPDATE public.branches
     SET name = COALESCE(NULLIF(btrim(v_patch->>'name'), ''), name),
         code = COALESCE(lower(NULLIF(btrim(v_patch->>'code'), '')), code),
         branch_type = COALESCE(NULLIF(btrim(v_patch->>'branch_type'), ''), branch_type),
         timezone = COALESCE(NULLIF(btrim(v_patch->>'timezone'), ''), timezone),
         address = COALESCE(v_patch->'address', address),
         coordinates = CASE WHEN v_coordinates_present THEN v_coordinates ELSE coordinates END,
         operating_hours = COALESCE(v_patch->'operating_hours', operating_hours),
         is_active = COALESCE((v_patch->>'is_active')::boolean, is_active),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(v_patch->'metadata', '{}'::jsonb),
         updated_at = now()
   WHERE id = v_branch_id;

  v_changed := jsonb_strip_nulls(jsonb_build_object(
    'name', NULLIF(btrim(v_patch->>'name'), ''),
    'code', NULLIF(btrim(v_patch->>'code'), ''),
    'branch_type', NULLIF(btrim(v_patch->>'branch_type'), ''),
    'timezone', NULLIF(btrim(v_patch->>'timezone'), ''),
    'is_active', v_patch->'is_active',
    'coordinates_present', CASE WHEN v_coordinates_present THEN v_coordinates IS NOT NULL ELSE NULL END
  ));

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_branch.organization_id, 'branch.updated', 'branch', v_branch_id, v_correlation_id,
    jsonb_build_object('branch_id', v_branch_id, 'changed', v_changed),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.update',
    p_resource_type := 'branch',
    p_resource_id := v_branch_id,
    p_decision_point := 'branch_update_v1',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'branch_update_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object('patch', v_patch)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_id', v_branch_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_update_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_update_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_update_v1(JSONB) IS
  'NETWORK canonical write RPC: patch public.branches row including optional coordinates + decision_log + domain_event. Capability: branches.write.';

CREATE OR REPLACE VIEW public.v_branch_directory
WITH (security_invoker = true) AS
SELECT
  b.*,
  CASE WHEN b.coordinates IS NULL THEN NULL ELSE ST_Y(b.coordinates::geometry)::DOUBLE PRECISION END AS lat,
  CASE WHEN b.coordinates IS NULL THEN NULL ELSE ST_X(b.coordinates::geometry)::DOUBLE PRECISION END AS lng
FROM public.branches b;

REVOKE ALL ON public.v_branch_directory FROM PUBLIC;
REVOKE ALL ON public.v_branch_directory FROM anon;
GRANT SELECT ON public.v_branch_directory TO authenticated, service_role;

COMMENT ON VIEW public.v_branch_directory IS
  'Console V2 branch read projection over public.branches with map-ready lat/lng derived from canonical PostGIS coordinates.';

CREATE OR REPLACE VIEW public.hubs
WITH (security_invoker = true) AS
SELECT
  b.id,
  b.organization_id,
  b.code,
  b.name,
  b.branch_type,
  NULLIF(b.address->>'city', '') AS city,
  COALESCE(
    NULLIF(b.operating_hours#>>'{cutoff_time}', ''),
    NULLIF(b.operating_hours#>>'{dispatch_cutoff_time}', ''),
    NULLIF(b.metadata#>>'{cutoff_time}', '')
  ) AS cutoff_time,
  b.is_active,
  b.created_at,
  b.updated_at,
  CASE WHEN b.coordinates IS NULL THEN NULL ELSE ST_Y(b.coordinates::geometry)::DOUBLE PRECISION END AS lat,
  CASE WHEN b.coordinates IS NULL THEN NULL ELSE ST_X(b.coordinates::geometry)::DOUBLE PRECISION END AS lng
FROM public.branches b
WHERE b.is_active IS DISTINCT FROM FALSE;

REVOKE ALL ON public.hubs FROM PUBLIC;
REVOKE ALL ON public.hubs FROM anon;
GRANT SELECT ON public.hubs TO authenticated, service_role;

COMMENT ON VIEW public.hubs IS
  'Console V2 operational-unit projection over branches for hub pickers and map markers. Read-only; SSOT remains public.branches.';

CREATE OR REPLACE VIEW public.v_branch_summary
WITH (security_invoker = true)
AS
WITH cap AS (
  SELECT
    bcw.branch_id,
    COALESCE(SUM(COALESCE((bcw.capacity->>'max_stops')::NUMERIC, 0)), 0)::NUMERIC AS capacity_per_day
  FROM public.branch_capacity_windows bcw
  WHERE bcw.is_active = TRUE
    AND (bcw.effective_to IS NULL OR bcw.effective_to > now())
  GROUP BY bcw.branch_id
),
veh AS (
  SELECT
    v.branch_id,
    COUNT(*)::INT AS active_vehicles
  FROM public.vehicles v
  WHERE v.branch_id IS NOT NULL
    AND v.is_active = TRUE
    AND v.status = 'active'
  GROUP BY v.branch_id
),
runs AS (
  SELECT
    rr.branch_id,
    COUNT(*)::INT AS active_routes
  FROM public.route_runs rr
  WHERE rr.branch_id IS NOT NULL
    AND rr.status IN ('planned', 'in_progress')
  GROUP BY rr.branch_id
),
mgr AS (
  SELECT
    bm.branch_id,
    MIN(bm.user_id::TEXT)::UUID AS manager_user_id
  FROM public.branch_memberships bm
  WHERE bm.is_active = TRUE
    AND bm.role_key = 'manager'
    AND (bm.effective_to IS NULL OR bm.effective_to > now())
  GROUP BY bm.branch_id
),
load AS (
  SELECT
    s.branch_id,
    COUNT(*)::INT AS booked_today
  FROM public.shipments s
  JOIN public.branches b ON b.id = s.branch_id
  WHERE s.branch_id IS NOT NULL
    AND s.promised_delivery_date = ((now() AT TIME ZONE COALESCE(NULLIF(b.timezone, ''), 'Asia/Riyadh'))::DATE)
  GROUP BY s.branch_id
)
SELECT
  b.id              AS branch_id,
  b.organization_id,
  b.code,
  b.name,
  b.branch_type,
  b.is_active,
  b.timezone,
  COALESCE(cap.capacity_per_day, 0)::NUMERIC AS capacity_per_day,
  COALESCE(veh.active_vehicles, 0)::INT      AS active_vehicles,
  COALESCE(runs.active_routes, 0)::INT       AS active_routes,
  mgr.manager_user_id,
  NULLIF(btrim(COALESCE(b.operating_hours->>'cutoff_time_local', '')), '') AS cutoff_time,
  b.updated_at,
  COALESCE(load.booked_today, 0)::INT AS booked_today,
  CASE WHEN b.coordinates IS NULL THEN NULL ELSE ST_Y(b.coordinates::geometry)::DOUBLE PRECISION END AS lat,
  CASE WHEN b.coordinates IS NULL THEN NULL ELSE ST_X(b.coordinates::geometry)::DOUBLE PRECISION END AS lng
FROM public.branches b
LEFT JOIN cap  ON cap.branch_id = b.id
LEFT JOIN veh  ON veh.branch_id = b.id
LEFT JOIN runs ON runs.branch_id = b.id
LEFT JOIN mgr  ON mgr.branch_id = b.id
LEFT JOIN load ON load.branch_id = b.id;

COMMENT ON VIEW public.v_branch_summary IS
  'FE-friendly projection of branches with derived counters and map coordinates (capacity_per_day, active_vehicles, active_routes, manager_user_id, cutoff_time, booked_today, lat, lng). Sources: branches + branch_capacity_windows + vehicles + route_runs + branch_memberships + shipments. Read-only; SSOT remains branches and shipment promise projections; mutations go through branch_create_v1 / branch_update_v1 / mark_branch_oos_v1.';

REVOKE ALL ON public.v_branch_summary FROM PUBLIC;
REVOKE ALL ON public.v_branch_summary FROM anon;
REVOKE ALL ON public.v_branch_summary FROM authenticated;
GRANT SELECT ON public.v_branch_summary TO authenticated;
GRANT SELECT ON public.v_branch_summary TO service_role;

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := v_setting.cached_value;

    SELECT COALESCE(
             jsonb_agg(
               CASE
                 WHEN resource.value->>'key' IN ('branches', 'branch_summary', 'hubs') THEN
                   jsonb_set(
                     jsonb_set(
                       resource.value,
                       '{relation}',
                       CASE
                         WHEN resource.value->>'key' = 'branches'
                           THEN to_jsonb('public.v_branch_directory'::TEXT)
                         ELSE to_jsonb(resource.value->>'relation')
                       END,
                       TRUE
                     ),
                     '{filters}',
                     CASE
                       WHEN EXISTS (
                         SELECT 1
                           FROM jsonb_array_elements(COALESCE(resource.value->'filters', '[]'::jsonb)) AS f(value)
                          WHERE f.value->>'key' = 'organization_id'
                       ) THEN COALESCE(resource.value->'filters', '[]'::jsonb)
                       ELSE COALESCE(resource.value->'filters', '[]'::jsonb) ||
                            jsonb_build_array(
                              jsonb_build_object(
                                'key', 'organization_id',
                                'column', 'organization_id',
                                'op', 'eq'
                              )
                            )
                     END,
                     TRUE
                   )
                 ELSE resource.value
               END
               ORDER BY resource.ordinality
             ),
             '[]'::jsonb
           )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
           WITH ORDINALITY AS resource(value, ordinality);

    v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           updated_at = now(),
           change_reason = 'Expose Console V2 branch coordinates through map-ready registry projections'
     WHERE id = v_setting.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_setting.setting_id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605061520_console_v2_branch_coordinates_rpc_and_maps_v1'));

COMMIT;
