-- Migration: UC084 task-context contact contract v1
-- Purpose:
--   - Make route_stop_execute tasks carry canonical customer contact context from the related shipment.
--   - Allow task-context support/dispatcher contacts to flow from the authoritative route assignment metadata.
--   - Extend communication_policy with row-driven support_contacts for Field Ops contact actions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101430_uc084_task_context_contact_contract_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical route-stop task contact metadata helper
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_stop_task_contact_metadata_v1(
  p_route_stop_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_stop RECORD;
  v_assignment JSONB := '{}'::jsonb;
  v_support_contacts JSONB := '[]'::jsonb;
BEGIN
  IF p_route_stop_id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT
    rs.id,
    rs.route_run_id,
    rs.client_id,
    rs.shipment_id,
    rs.sequence_order,
    rs.stop_kind,
    rr.branch_id,
    s.sender_id,
    s.tracking_number,
    COALESCE(
      NULLIF(btrim(COALESCE(r.name, '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'customer_name', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'recipient_name', '')), '')
    ) AS customer_name,
    COALESCE(
      NULLIF(btrim(COALESCE(r.phone_number, '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'customer_phone', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'recipient_phone', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata #>> '{customer,phone_number}', '')), '')
    ) AS customer_phone,
    a.raw_input,
    a.normalized_line1,
    a.normalized_line2,
    a.building_number,
    a.district,
    a.city,
    a.province,
    a.postal_code,
    a.country,
    a.additional_directions
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  LEFT JOIN public.recipients r
    ON r.id = s.recipient_id
   AND r.client_id = s.client_id
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
   AND a.client_id = s.client_id
  WHERE rs.id = p_route_stop_id
  LIMIT 1;

  IF v_stop.id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  v_assignment := COALESCE(public.route_run_assignment_projection_v1(v_stop.route_run_id), '{}'::jsonb);
  v_support_contacts := COALESCE(v_assignment #> '{metadata,support_contacts}', '[]'::jsonb);
  IF jsonb_typeof(v_support_contacts) IS DISTINCT FROM 'array' THEN
    v_support_contacts := '[]'::jsonb;
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_stop.route_run_id,
      'route_stop_id', v_stop.id,
      'branch_id', v_stop.branch_id,
      'client_id', v_stop.client_id,
      'sender_id', v_stop.sender_id,
      'route_stop',
        jsonb_strip_nulls(
          jsonb_build_object(
            'id', v_stop.id,
            'route_run_id', v_stop.route_run_id,
            'shipment_id', v_stop.shipment_id,
            'client_id', v_stop.client_id,
            'branch_id', v_stop.branch_id,
            'sequence_order', v_stop.sequence_order,
            'stop_kind', v_stop.stop_kind
          )
        ),
      'customer',
        CASE
          WHEN v_stop.customer_name IS NULL
            AND v_stop.customer_phone IS NULL
            AND v_stop.tracking_number IS NULL
          THEN NULL
          ELSE jsonb_strip_nulls(
            jsonb_build_object(
              'name', v_stop.customer_name,
              'phone_number', v_stop.customer_phone,
              'reference', v_stop.tracking_number,
              'tracking_number', v_stop.tracking_number
            )
          )
        END,
      'contact',
        CASE
          WHEN v_stop.customer_phone IS NULL THEN NULL
          ELSE jsonb_build_object('phone_number', v_stop.customer_phone)
        END,
      'address',
        CASE
          WHEN v_stop.raw_input IS NULL
            AND v_stop.normalized_line1 IS NULL
            AND v_stop.normalized_line2 IS NULL
            AND v_stop.district IS NULL
            AND v_stop.city IS NULL
            AND v_stop.province IS NULL
            AND v_stop.postal_code IS NULL
          THEN NULL
          ELSE jsonb_strip_nulls(
            jsonb_build_object(
              'address', v_stop.raw_input,
              'raw_input', v_stop.raw_input,
              'line1', v_stop.normalized_line1,
              'line2', v_stop.normalized_line2,
              'building_number', v_stop.building_number,
              'district', v_stop.district,
              'city', v_stop.city,
              'province', v_stop.province,
              'postal_code', v_stop.postal_code,
              'country', v_stop.country,
              'additional_directions', v_stop.additional_directions
            )
          )
        END,
      'support_contacts',
        CASE
          WHEN jsonb_array_length(v_support_contacts) = 0 THEN NULL
          ELSE v_support_contacts
        END
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID)
  IS 'Canonical route_stop task metadata fragment for Field Ops task context. Carries customer/address data from the shipment and support_contacts from the current route assignment metadata when available.';

REVOKE ALL ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.route_run_sync_stop_task_metadata_v1(
  p_route_run_id UUID,
  p_assignment_mode TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_updated_count INTEGER := 0;
BEGIN
  IF p_route_run_id IS NULL THEN
    RETURN 0;
  END IF;

  WITH desired AS (
    SELECT
      t.id,
      public.jsonb_deep_merge(
        COALESCE(t.metadata, '{}'::jsonb),
        public.jsonb_deep_merge(
          public.route_stop_task_contact_metadata_v1(rs.id),
          jsonb_strip_nulls(jsonb_build_object('assignment_mode', p_assignment_mode))
        )
      ) AS next_metadata
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
    JOIN public.route_stops rs
      ON rs.id = t.resource_id
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
    WHERE rs.route_run_id = p_route_run_id
      AND t.resource_type = 'route_stop'
      AND tt.organization_id = rr.organization_id
      AND tt.key = 'route_stop_execute'
  )
  UPDATE public.tasks t
     SET metadata = desired.next_metadata
    FROM desired
   WHERE t.id = desired.id
     AND COALESCE(t.metadata, '{}'::jsonb) IS DISTINCT FROM desired.next_metadata;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$function$;

COMMENT ON FUNCTION public.route_run_sync_stop_task_metadata_v1(UUID, TEXT)
  IS 'Backfill route_stop_execute task metadata from the canonical route_stop contact snapshot for an entire route run.';

REVOKE ALL ON FUNCTION public.route_run_sync_stop_task_metadata_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_sync_stop_task_metadata_v1(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_run_sync_stop_task_metadata_v1(UUID, TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Workflow task fanout: route_stop_execute tasks inherit contact metadata
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_task_enqueue_many_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_meta JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);

  v_context_key TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'context_key', '')), ''), 'tasks_many');
  v_items_path TEXT := NULLIF(btrim(COALESCE(v_meta->>'items_jsonpath', '')), '');
  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'task_type_key', '')), ''));
  v_resource_type TEXT := lower(NULLIF(btrim(COALESCE(v_meta->>'resource_type', '')), ''));
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_meta->>'actor_system', '')), ''), 'workflow_engine');
  v_idempotency_prefix TEXT := COALESCE(
    NULLIF(btrim(COALESCE(v_meta->>'idempotency_prefix', '')), ''),
    NULLIF(btrim(COALESCE(v_ctx->>'idempotency_key', '')), ''),
    format('workflow_run:%s:step:%s', p_run.id, p_step.id)
  );

  v_org_id UUID := NULL;
  v_items JSONB := NULL;
  v_item JSONB;

  v_i INT := 0;
  v_resource_id UUID := NULL;
  v_idempotency_key TEXT := NULL;

  v_task_metadata_base JSONB := COALESCE(v_meta->'task_metadata', '{}'::jsonb);
  v_task_metadata JSONB := '{}'::jsonb;

  v_created RECORD;

  v_task_ids UUID[] := '{}'::uuid[];
  v_task_event_ids UUID[] := '{}'::uuid[];
  v_task_workflow_run_ids UUID[] := '{}'::uuid[];

  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_service_claims JSONB := '{}'::jsonb;

  v_resp public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  IF v_items_path IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.items_jsonpath (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.task_type_key (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;
  IF v_resource_type IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: missing metadata.resource_type (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  BEGIN v_org_id := NULLIF(v_ctx->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'task_enqueue_many: organization_id missing from workflow context (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
  END IF;

  v_items := public.safe_jsonpath_query_first(v_ctx, v_items_path);
  IF v_items IS NULL OR jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'task_enqueue_many: items_jsonpath did not resolve to array (path=% workflow_run_id=% step_id=%)', v_items_path, p_run.id, p_step.id;
  END IF;

  IF jsonb_typeof(v_task_metadata_base) IS DISTINCT FROM 'object' THEN
    v_task_metadata_base := '{}'::jsonb;
  END IF;

  BEGIN
    v_service_claims := NULLIF(v_prev_claims, '')::jsonb;
  EXCEPTION
    WHEN others THEN
      v_service_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := v_service_claims || jsonb_build_object('role', 'service_role');

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_items) AS t(value)
  LOOP
    v_i := v_i + 1;

    v_resource_id := NULL;
    IF jsonb_typeof(v_item) = 'string' THEN
      BEGIN v_resource_id := NULLIF(trim(both '"' FROM v_item::text), '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    ELSIF jsonb_typeof(v_item) = 'object' THEN
      BEGIN v_resource_id := NULLIF(v_item->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
    END IF;

    IF v_resource_id IS NULL THEN
      RAISE EXCEPTION 'task_enqueue_many: item % missing resource_id/uuid', v_i USING ERRCODE = '23514';
    END IF;

    v_idempotency_key := format('%s:item:%s', v_idempotency_prefix, v_resource_id);

    v_task_metadata := public.jsonb_deep_merge(
      v_task_metadata_base,
      jsonb_strip_nulls(jsonb_build_object(
        'parent_workflow_run_id', p_run.id,
        'parent_workflow_step_id', p_step.id,
        'fanout_index', v_i
      ))
    );

    IF v_task_type_key = 'route_stop_execute' AND v_resource_type = 'route_stop' THEN
      v_task_metadata := public.jsonb_deep_merge(
        v_task_metadata,
        public.route_stop_task_contact_metadata_v1(v_resource_id)
      );
    END IF;

    SELECT *
      INTO v_created
      FROM public.create_task_system_v1(
        jsonb_strip_nulls(jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', jsonb_build_object('organization_id', v_org_id),
          'resource_type', v_resource_type,
          'resource_id', v_resource_id,
          'idempotency_key', v_idempotency_key,
          'metadata', v_task_metadata,
          'actor_system', v_actor_system
        ))
      )
      LIMIT 1;

    IF v_created.task_id IS NULL THEN
      RAISE EXCEPTION 'task_enqueue_many: create_task_system_v1 returned NULL task_id (idx=% resource_id=%)', v_i, v_resource_id
        USING ERRCODE = '23514';
    END IF;

    v_task_ids := array_append(v_task_ids, v_created.task_id);
    v_task_event_ids := array_append(v_task_event_ids, v_created.task_event_id);
    v_task_workflow_run_ids := array_append(v_task_workflow_run_ids, v_created.workflow_run_id);
  END LOOP;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'count', v_i,
    'task_ids', to_jsonb(v_task_ids),
    'task_event_ids', to_jsonb(v_task_event_ids),
    'task_workflow_run_ids', to_jsonb(v_task_workflow_run_ids)
  ));
  v_resp.context_patch := jsonb_build_object(
    v_context_key,
    jsonb_strip_nulls(jsonb_build_object(
      'count', v_i,
      'task_ids', to_jsonb(v_task_ids),
      'task_event_ids', to_jsonb(v_task_event_ids),
      'task_workflow_run_ids', to_jsonb(v_task_workflow_run_ids)
    ))
  );

  RETURN v_resp;
EXCEPTION
  WHEN others THEN
    PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
    RAISE;
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Task trigger + one-time backfill for route_stop_execute contact metadata
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_tasks_route_stop_contact_metadata_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task_type_key TEXT := NULL;
BEGIN
  IF lower(COALESCE(NEW.resource_type, '')) <> 'route_stop' OR NEW.resource_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = NEW.task_type_id
   LIMIT 1;

  IF lower(COALESCE(v_task_type_key, '')) <> 'route_stop_execute' THEN
    RETURN NEW;
  END IF;

  IF NEW.metadata IS NULL OR jsonb_typeof(NEW.metadata) IS DISTINCT FROM 'object' THEN
    NEW.metadata := '{}'::jsonb;
  END IF;

  NEW.metadata := public.jsonb_deep_merge(
    NEW.metadata,
    public.route_stop_task_contact_metadata_v1(NEW.resource_id)
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_tasks_route_stop_contact_metadata_v1()
  IS 'Ensure route_stop_execute tasks always carry canonical customer/support contact metadata for Field Ops task context.';

DROP TRIGGER IF EXISTS tg_tasks_route_stop_contact_metadata_v1 ON public.tasks;
CREATE TRIGGER tg_tasks_route_stop_contact_metadata_v1
  BEFORE INSERT OR UPDATE OF metadata, resource_id, task_type_id
  ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_tasks_route_stop_contact_metadata_v1();

CREATE OR REPLACE FUNCTION public.tg_route_run_assignments_sync_stop_task_metadata_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_assignment_mode TEXT := NULLIF(btrim(COALESCE(NEW.assignment_mode, '')), '');
BEGIN
  IF NEW.route_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.route_run_sync_stop_task_metadata_v1(NEW.route_run_id, v_assignment_mode);
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_route_run_assignments_sync_stop_task_metadata_v1()
  IS 'Refresh route_stop_execute task metadata whenever the canonical route_run assignment row changes so support_contacts/task context stay aligned with assignment SSOT.';

DROP TRIGGER IF EXISTS tg_route_run_assignments_sync_stop_task_metadata_v1 ON public.route_run_assignments;
CREATE TRIGGER tg_route_run_assignments_sync_stop_task_metadata_v1
  AFTER INSERT OR UPDATE OF assignment_mode, assignment_status, driver_user_id, vehicle_id, metadata
  ON public.route_run_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_route_run_assignments_sync_stop_task_metadata_v1();

DO $do$
DECLARE
  v_route_run_id UUID;
  v_assignment_mode TEXT;
BEGIN
  FOR v_route_run_id IN
    SELECT DISTINCT rs.route_run_id
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
    JOIN public.route_stops rs
      ON rs.id = t.resource_id
    WHERE t.resource_type = 'route_stop'
      AND tt.key = 'route_stop_execute'
  LOOP
    v_assignment_mode := NULLIF(COALESCE(public.route_run_assignment_projection_v1(v_route_run_id)->>'assignment_mode', ''), '');
    PERFORM public.route_run_sync_stop_task_metadata_v1(v_route_run_id, v_assignment_mode);
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 4) communication_policy schema/defaults support support_contacts
-------------------------------------------------------------------------------

UPDATE public.schema_registry
   SET schema = jsonb_set(
         COALESCE(schema, '{}'::jsonb),
         '{properties,support_contacts}',
         jsonb_build_object('type', jsonb_build_array('array', 'null')),
         TRUE
       ),
       examples = jsonb_build_array(
         jsonb_build_object(
           'version', 1,
           'allowed_channels', jsonb_build_array('call', 'sms', 'whatsapp'),
           'support_contacts', jsonb_build_array(
             jsonb_build_object(
               'role', 'dispatcher',
               'label', 'Dispatcher',
               'phone_number', '+12025550123',
               'allowed_channels', jsonb_build_array('call', 'sms')
             )
           ),
           'templates', jsonb_build_array()
         )
       ),
       updated_at = now()
 WHERE category = 'communication_policy'
   AND version = 1;

UPDATE public.settings_versions
   SET value = jsonb_set(
         COALESCE(value, '{}'::jsonb),
         '{support_contacts}',
         COALESCE(value->'support_contacts', '[]'::jsonb),
         TRUE
       ),
       version = version + 1,
       change_reason = 'uc084 communication policy support contacts',
       approved_at = workflow_now(),
       effective_from = workflow_now()
 WHERE category = 'communication_policy'
   AND scope_type = 'global'
   AND scope_id IS NULL
   AND COALESCE(value->'support_contacts', 'null'::jsonb) IS DISTINCT FROM COALESCE(value->'support_contacts', '[]'::jsonb);

UPDATE public.settings
   SET cached_value = jsonb_set(
         COALESCE(cached_value, '{}'::jsonb),
         '{support_contacts}',
         COALESCE(cached_value->'support_contacts', '[]'::jsonb),
         TRUE
       ),
       last_updated = workflow_now()
 WHERE category = 'communication_policy'
   AND scope_type = 'global'
   AND scope_id IS NULL
   AND COALESCE(cached_value->'support_contacts', 'null'::jsonb) IS DISTINCT FROM COALESCE(cached_value->'support_contacts', '[]'::jsonb);

SELECT pg_advisory_unlock(hashtext('202604101430_uc084_task_context_contact_contract_v1'));
COMMIT;
