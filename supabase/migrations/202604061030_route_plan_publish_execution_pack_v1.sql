-- Plan: PLAN-202604-b06-route-plan-publish / Step: S01
-- Migration: Route plan publish execution pack v1
-- Date: 2026-04-06
--
-- Goals:
--   - Add the canonical freeze/publish closeout contract for route_plans.
--   - Record an auditable execution-pack hash before downstream execution surfaces consume the plan.
--   - Keep execution-pack visibility browser-safe through api/ui wrappers and the route workspace registry contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061030_route_plan_publish_execution_pack_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Publish status + route_plan audit columns
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  'published',
  'Published',
  'Frozen execution pack is published and visible to downstream execution surfaces',
  37,
  FALSE,
  '{}'::jsonb
FROM public.lookup_definitions ld
WHERE ld.category = 'route_plan_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

ALTER TABLE public.route_plans
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS published_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_execution_pack_hash TEXT NULL;

ALTER TABLE public.route_plans
  DROP CONSTRAINT IF EXISTS route_plans_published_execution_pack_hash_ck;
ALTER TABLE public.route_plans
  ADD CONSTRAINT route_plans_published_execution_pack_hash_ck
  CHECK (
    published_execution_pack_hash IS NULL
    OR btrim(published_execution_pack_hash) <> ''
  );

CREATE INDEX IF NOT EXISTS idx_route_plans_org_published_at
  ON public.route_plans (organization_id, published_at DESC)
  WHERE published_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_route_plans__published_by_user_id__fk
  ON public.route_plans (published_by_user_id)
  WHERE published_by_user_id IS NOT NULL;

COMMENT ON COLUMN public.route_plans.published_at
  IS 'Timestamp when the canonical execution pack became visible to downstream execution surfaces.';
COMMENT ON COLUMN public.route_plans.published_by_user_id
  IS 'Authenticated operator that published the execution pack.';
COMMENT ON COLUMN public.route_plans.published_execution_pack_hash
  IS 'Deterministic sha256 hash of the published execution pack payload.';

-------------------------------------------------------------------------------
-- 2) Canonical execution-pack helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_plan_execution_pack_hash_v1(
  p_payload JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT encode(digest(COALESCE(p_payload, '{}'::jsonb)::text, 'sha256'), 'hex');
$function$;

COMMENT ON FUNCTION public.route_plan_execution_pack_hash_v1(JSONB)
  IS 'Deterministic sha256 hash for the canonical route_plan execution-pack payload.';

REVOKE ALL ON FUNCTION public.route_plan_execution_pack_hash_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_execution_pack_hash_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_execution_pack_hash_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_execution_pack_hash_v1(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.route_plan_execution_pack_build_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plan public.route_plans%ROWTYPE;
  v_stops JSONB := '[]'::jsonb;
  v_stop_count INT := 0;
  v_shipment_ids JSONB := '[]'::jsonb;
  v_shipment_count INT := 0;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_optimizer JSONB := NULL;
  v_pack_core JSONB := '{}'::jsonb;
  v_pack_hash TEXT := NULL;
BEGIN
  SELECT *
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = p_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_stops := public.route_plan_resolve_stops_v1(v_plan.id);
  IF jsonb_typeof(v_stops) IS DISTINCT FROM 'array' THEN
    v_stops := '[]'::jsonb;
  END IF;

  v_stop_count := COALESCE(jsonb_array_length(v_stops), 0);

  SELECT
    COALESCE(jsonb_agg(to_jsonb(shipment_id_text) ORDER BY shipment_id_text), '[]'::jsonb),
    COUNT(*)::INT
    INTO v_shipment_ids,
         v_shipment_count
    FROM (
      SELECT DISTINCT NULLIF(btrim(COALESCE(item.value->>'shipment_id', '')), '') AS shipment_id_text
      FROM jsonb_array_elements(v_stops) AS item(value)
      WHERE NULLIF(btrim(COALESCE(item.value->>'shipment_id', '')), '') IS NOT NULL
    ) shipments;

  BEGIN
    v_driver_user_id := NULLIF(COALESCE(v_plan.solution->>'driver_user_id', v_plan.inputs->>'driver_user_id', ''), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_driver_user_id := NULL;
  END;

  BEGIN
    v_vehicle_id := NULLIF(COALESCE(v_plan.solution->>'vehicle_id', v_plan.inputs->>'vehicle_id', ''), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_vehicle_id := NULL;
  END;

  IF jsonb_typeof(COALESCE(v_plan.solution->'optimizer', 'null'::jsonb)) = 'object' THEN
    v_optimizer := v_plan.solution->'optimizer';
  END IF;

  v_pack_core := jsonb_strip_nulls(
    jsonb_build_object(
      'route_plan_id', v_plan.id,
      'organization_id', v_plan.organization_id,
      'branch_id', v_plan.branch_id,
      'planned_date', v_plan.planned_date,
      'version', v_plan.version,
      'driver_user_id', v_driver_user_id,
      'vehicle_id', v_vehicle_id,
      'shipment_ids', v_shipment_ids,
      'stops', v_stops,
      'optimizer', v_optimizer,
      'source', jsonb_build_object(
        'resource', 'route_plans',
        'route_plan_version', v_plan.version
      )
    )
  );

  v_pack_hash := public.route_plan_execution_pack_hash_v1(v_pack_core);

  RETURN jsonb_strip_nulls(
    v_pack_core
    || jsonb_build_object(
      'route_plan_status', v_plan.status,
      'published_at', v_plan.published_at,
      'published_by_user_id', v_plan.published_by_user_id,
      'execution_pack_hash', COALESCE(v_plan.published_execution_pack_hash, v_pack_hash),
      'stop_count', v_stop_count,
      'shipment_count', v_shipment_count
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_plan_execution_pack_build_v1(UUID)
  IS 'Canonical execution-pack builder derived from route_plan SSOT state; used by publish and downstream visibility.';

REVOKE ALL ON FUNCTION public.route_plan_execution_pack_build_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_execution_pack_build_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_execution_pack_build_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_execution_pack_build_v1(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.route_plan_execution_pack_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plan RECORD;
BEGIN
  SELECT
    rp.id,
    rp.status,
    rp.published_at
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = p_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_plan.status NOT IN ('published', 'applied') OR v_plan.published_at IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN public.route_plan_execution_pack_build_v1(p_route_plan_id);
END;
$function$;

COMMENT ON FUNCTION public.route_plan_execution_pack_v1(UUID)
  IS 'Published-only execution-pack projection for downstream route execution surfaces.';

REVOKE ALL ON FUNCTION public.route_plan_execution_pack_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_execution_pack_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_execution_pack_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_execution_pack_v1(UUID) TO service_role;

-------------------------------------------------------------------------------
-- 3) Canonical publish service RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.publish_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  version INT,
  execution_pack_hash TEXT,
  stop_count INT,
  shipment_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_plan_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_plan public.route_plans%ROWTYPE;
  v_pack JSONB := '{}'::jsonb;
  v_computed_hash TEXT := NULL;
  v_from_status TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'publish_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'publish_route_plan_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   FOR UPDATE;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'publish_route_plan_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  v_from_status := v_plan.status;
  IF v_from_status NOT IN ('frozen', 'published') THEN
    RAISE EXCEPTION 'publish_route_plan_v1 requires route_plan % to be frozen/published (got %)', v_route_plan_id, v_from_status
      USING ERRCODE = '23514';
  END IF;

  v_pack := public.route_plan_execution_pack_build_v1(v_route_plan_id);
  IF jsonb_typeof(COALESCE(v_pack, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'publish_route_plan_v1 could not build execution pack for route_plan %', v_route_plan_id
      USING ERRCODE = '23514';
  END IF;

  execution_pack_hash := NULLIF(v_pack->>'execution_pack_hash', '');
  stop_count := COALESCE((v_pack->>'stop_count')::INT, 0);
  shipment_count := COALESCE((v_pack->>'shipment_count')::INT, 0);

  IF execution_pack_hash IS NULL OR stop_count < 1 THEN
    RAISE EXCEPTION 'publish_route_plan_v1 requires a frozen execution pack with at least one stop'
      USING ERRCODE = '23514';
  END IF;

  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), ''),
    format('route-plan:%s:publish:%s', v_route_plan_id, execution_pack_hash)
  );

  IF v_from_status = 'published'
     AND v_plan.published_at IS NOT NULL
     AND COALESCE(v_plan.published_execution_pack_hash, '') <> ''
  THEN
    v_computed_hash := public.route_plan_execution_pack_hash_v1(
      (
        v_pack
        - 'route_plan_status'
        - 'published_at'
        - 'published_by_user_id'
        - 'execution_pack_hash'
        - 'stop_count'
        - 'shipment_count'
      )
    );

    IF v_plan.published_execution_pack_hash IS DISTINCT FROM v_computed_hash THEN
      RAISE EXCEPTION 'publish_route_plan_v1 detected execution-pack drift for route_plan %', v_route_plan_id
        USING ERRCODE = '23514';
    END IF;

    route_plan_id := v_route_plan_id;
    status := 'published';
    version := v_plan.version;
    execution_pack_hash := v_plan.published_execution_pack_hash;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.route_plans
     SET status = 'published',
         solved_at = COALESCE(solved_at, now()),
         published_at = COALESCE(published_at, now()),
         published_by_user_id = COALESCE(published_by_user_id, v_actor_user_id),
         published_execution_pack_hash = execution_pack_hash,
         updated_at = now()
   WHERE id = v_route_plan_id;

  PERFORM public.route_plan_log_event_v1(
    v_route_plan_id,
    'published',
    v_from_status,
    'published',
    jsonb_strip_nulls(
      jsonb_build_object(
        'execution_pack_hash', execution_pack_hash,
        'stop_count', stop_count,
        'shipment_count', shipment_count
      )
    ),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key
  );

  route_plan_id := v_route_plan_id;
  status := 'published';
  version := v_plan.version;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.publish_route_plan_v1(JSONB)
  IS 'Service write-path: publish the canonical route_plan execution pack before downstream execution consumes the plan.';

REVOKE ALL ON FUNCTION public.publish_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_route_plan_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.publish_route_plan_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.publish_route_plan_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 4) Apply contract: published plans remain the canonical downstream source
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_plan_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_idempotency_key TEXT := NULL;

  v_plan RECORD;
  v_stops JSONB := '[]'::jsonb;
  v_create_result RECORD;
  v_existing_route_run_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_from_status TEXT := NULL;
  v_execution_pack_hash TEXT := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'apply_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), ''),
    format('route-plan:%s:apply', v_route_plan_id)
  );

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT rp.*
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  v_from_status := v_plan.status;
  v_execution_pack_hash := NULLIF(COALESCE(v_plan.published_execution_pack_hash, ''), '');

  SELECT rr.id
    INTO v_existing_route_run_id
    FROM public.route_runs rr
   WHERE rr.route_plan_id = v_route_plan_id
   LIMIT 1;

  IF v_plan.status = 'applied' AND v_existing_route_run_id IS NOT NULL THEN
    route_plan_id := v_route_plan_id;
    route_run_id := v_existing_route_run_id;
    stop_ids := ARRAY(
      SELECT rs.id
      FROM public.route_stops rs
      WHERE rs.route_run_id = v_existing_route_run_id
      ORDER BY rs.sequence_order
    );
    created := FALSE;
    status := 'applied';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_plan.status NOT IN ('frozen', 'published') THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires route_plan % to be frozen/published (got %)', v_route_plan_id, v_plan.status
      USING ERRCODE = '23514';
  END IF;

  v_stops := public.route_plan_resolve_stops_v1(v_route_plan_id);
  IF jsonb_typeof(v_stops) <> 'array' OR jsonb_array_length(v_stops) < 1 THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires a frozen/published route_plan with at least one stop' USING ERRCODE = '23514';
  END IF;

  BEGIN v_driver_user_id := NULLIF(COALESCE(v_plan.solution->>'driver_user_id', v_plan.inputs->>'driver_user_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(COALESCE(v_plan.solution->>'vehicle_id', v_plan.inputs->>'vehicle_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  SELECT *
    INTO v_create_result
    FROM public.create_route_run_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_plan.organization_id,
        'branch_id', v_plan.branch_id,
        'driver_user_id', v_driver_user_id,
        'vehicle_id', v_vehicle_id,
        'planned_date', v_plan.planned_date,
        'status', 'planned',
        'idempotency_key', v_idempotency_key,
        'stops', v_stops,
        'metadata',
          COALESCE(v_plan.metadata, '{}'::jsonb)
          || jsonb_strip_nulls(
            jsonb_build_object(
              'route_plan_id', v_plan.id,
              'route_plan_version', v_plan.version,
              'route_plan_execution_pack_hash', v_execution_pack_hash
            )
          )
      ))
    )
    LIMIT 1;

  UPDATE public.route_runs
     SET route_plan_id = v_route_plan_id,
         updated_at = now()
   WHERE id = v_create_result.route_run_id
     AND (
       public.route_runs.route_plan_id IS NULL
       OR public.route_runs.route_plan_id = v_route_plan_id
     );

  IF NOT EXISTS (
    SELECT 1
    FROM public.route_runs rr
    WHERE rr.id = v_create_result.route_run_id
      AND rr.route_plan_id = v_route_plan_id
  ) THEN
    RAISE EXCEPTION 'apply_route_plan_v1 could not link route_run % to route_plan %', v_create_result.route_run_id, v_route_plan_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.route_plans
     SET status = 'applied',
         applied_at = COALESCE(applied_at, now()),
         updated_at = now()
   WHERE id = v_route_plan_id;

  PERFORM public.route_plan_log_event_v1(
    v_route_plan_id,
    'applied',
    v_from_status,
    'applied',
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_create_result.route_run_id,
      'stop_ids', to_jsonb(v_create_result.stop_ids),
      'execution_pack_hash', v_execution_pack_hash
    )),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key
  );

  route_plan_id := v_route_plan_id;
  route_run_id := v_create_result.route_run_id;
  stop_ids := v_create_result.stop_ids;
  created := COALESCE(v_create_result.created, FALSE);
  status := 'applied';
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.apply_route_plan_v1(JSONB) IS
  'Service write-path: apply a frozen/published route_plan into route_runs/route_stops while carrying the published execution-pack hash downstream.';

-------------------------------------------------------------------------------
-- 5) Browser-safe UI/API wrappers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_publish_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  version INT,
  execution_pack_hash TEXT,
  stop_count INT,
  shipment_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx RECORD;
  v_plan public.route_plans%ROWTYPE;
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_payload JSONB := '{}'::jsonb;
  v_route_plan_id UUID := NULL;
BEGIN
  SELECT *
    INTO v_ctx
    FROM public.ui_route_plan_actor_context_v1('write')
   LIMIT 1;

  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'ui_publish_route_plan_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_plan_id := NULL;
  END;

  SELECT *
    INTO v_plan
    FROM public.ui_route_plan_visible_v1(v_route_plan_id, 'write');

  v_payload := (v_input - 'organization_id' - 'requested_by_user_id' - 'actor_user_id' - 'actor_system');
  v_payload := jsonb_strip_nulls(
    v_payload || jsonb_build_object(
      'route_plan_id', v_plan.id,
      'actor_user_id', v_ctx.user_id,
      'actor_system', 'route_plan_ui'
    )
  );

  RETURN QUERY
  SELECT *
  FROM public.publish_route_plan_v1(v_payload);
END;
$function$;

COMMENT ON FUNCTION public.ui_publish_route_plan_v1(JSONB) IS
  'Authenticated UI write-path for route_plan publish with server-derived actor context.';

REVOKE ALL ON FUNCTION public.ui_publish_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_publish_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_publish_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_route_plan_execution_pack_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plan public.route_plans%ROWTYPE;
BEGIN
  SELECT *
    INTO v_plan
    FROM public.ui_route_plan_visible_v1(p_route_plan_id, 'read');

  RETURN public.route_plan_execution_pack_v1(v_plan.id);
END;
$function$;

COMMENT ON FUNCTION public.ui_route_plan_execution_pack_v1(UUID) IS
  'Authenticated UI read-path for the published route_plan execution pack.';

REVOKE ALL ON FUNCTION public.ui_route_plan_execution_pack_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_route_plan_execution_pack_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_route_plan_execution_pack_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_publish_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  version INT,
  execution_pack_hash TEXT,
  stop_count INT,
  shipment_count INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_publish_route_plan_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_publish_route_plan_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_publish_route_plan_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_publish_route_plan_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_route_plan_execution_pack_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_route_plan_execution_pack_v1($1);
$fn$;

REVOKE ALL ON FUNCTION api.ui_route_plan_execution_pack_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_route_plan_execution_pack_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_route_plan_execution_pack_v1(UUID) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 6) api.route_plans execution-pack summary visibility
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW api.route_plans
WITH (security_invoker = true) AS
SELECT *
FROM public.route_plans;

REVOKE ALL ON api.route_plans FROM PUBLIC;
REVOKE ALL ON api.route_plans FROM anon;
GRANT SELECT ON api.route_plans TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 7) Dedicated UI command executor for route-plan publish
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_route_plan_publish_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_execution JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_mode TEXT := '';
  v_min INT := 0;
  v_max INT := NULL;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_selection_id_text TEXT := NULL;
  v_selection_uuid UUID := NULL;
  v_visible_plan JSONB := NULL;
  v_result RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 requires action key';
  END IF;
  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_params := COALESCE(v_execution->'params', '{}'::jsonb) || COALESCE(p_params, '{}'::jsonb);

  v_selection_id_text := COALESCE(
    NULLIF(v_id, ''),
    CASE WHEN array_length(v_ids, 1) IS NOT NULL THEN v_ids[1] ELSE NULL END
  );

  BEGIN
    v_selection_uuid := NULLIF(btrim(COALESCE(v_selection_id_text, '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_selection_uuid := NULL;
  END;

  IF v_selection_uuid IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 invalid route_plan id %', v_selection_id_text;
  END IF;

  v_visible_plan := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);
  IF v_visible_plan IS NULL THEN
    RAISE EXCEPTION 'ui_execute_route_plan_publish_v1 route_plan % is not visible in resource %', v_selection_uuid, p_resource_key
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_result
    FROM public.ui_publish_route_plan_v1(
      jsonb_strip_nulls(
        COALESCE(v_params, '{}'::jsonb)
        || jsonb_build_object('route_plan_id', v_selection_uuid)
      )
    )
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', 'published',
    'action_key', p_action_key,
    'resource_key', p_resource_key,
    'count', 1,
    'items', jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'route_plan_id', v_result.route_plan_id,
          'status', v_result.status,
          'version', v_result.version,
          'execution_pack_hash', v_result.execution_pack_hash,
          'stop_count', v_result.stop_count,
          'shipment_count', v_result.shipment_count
        )
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_route_plan_publish_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Publish visible route_plans into the canonical execution-pack contract without widening ui_execute_command_v1.';

REVOKE ALL ON FUNCTION public.ui_execute_route_plan_publish_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_route_plan_publish_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_route_plan_publish_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_execute_route_plan_publish_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_execute_route_plan_publish_v1($1, $2, $3, $4, $5, $6);
$fn$;

REVOKE ALL ON FUNCTION api.ui_execute_route_plan_publish_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_route_plan_publish_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_route_plan_publish_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 8) ui_command_registry route-plan publish command
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['route_plans.publish'],
    jsonb_build_object(
      'key', 'route_plans.publish',
      'label', 'Publish execution pack',
      'description', 'Publish the selected route plan as the canonical execution pack for downstream execution surfaces.',
      'capability', 'route_plans.write',
      'schema_category', 'resource:route_plans',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_route_plan_publish_v1',
        'params', '{}'::jsonb,
        'confirm', jsonb_build_object(
          'title', 'Publish execution pack?',
          'description', 'This locks the route plan into a published execution pack for downstream execution visibility and audit.',
          'confirm_label', 'Publish execution pack',
          'cancel_label', 'Cancel',
          'tone', 'default'
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key = 'route_plans.publish' THEN
        v_command := public.deep_merge_jsonb(v_canonical_commands->v_command_key, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item(value)
      WHERE item.value->>'key' = 'route_plans.publish'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_commands->'route_plans.publish');
    END IF;

    v_next := jsonb_set(v_current, ARRAY['commands'], v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             change_reason = 'Expose route_plans.publish through ui_command_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

COMMIT;
