-- Console V2 shipment detail readiness:
-- - keep timeline summaries operator-facing for policy/provider failures
-- - avoid exposing raw provider URL exceptions in the shipment timeline RPC
-- - preserve the existing executor-scoped visibility contract

BEGIN;
SELECT pg_advisory_lock(hashtext('202606101230_console_v2_shipment_timeline_comms_action_readiness_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.shipment_timeline_policy_gap_v1(
  p_text TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT lower(COALESCE(p_text, '')) ~ 'policy[_[:space:]-]+not[_[:space:]-]+found';
$function$;

CREATE OR REPLACE FUNCTION public.shipment_timeline_public_text_v1(
  p_text TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN public.shipment_timeline_policy_gap_v1(p_text) THEN NULL
    ELSE NULLIF(btrim(COALESCE(p_text, '')), '')
  END;
$function$;

CREATE OR REPLACE FUNCTION public.shipment_timeline_provider_error_class_v1(
  p_error_message TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN lower(COALESCE(p_error_message, '')) LIKE '%invalid url%' THEN 'provider_endpoint_invalid'
    WHEN NULLIF(btrim(COALESCE(p_error_message, '')), '') IS NOT NULL THEN 'provider_delivery_failed'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.shipment_timeline_operator_summary_v1(
  p_event_source TEXT,
  p_summary TEXT,
  p_error_message TEXT DEFAULT NULL,
  p_response_status_code INTEGER DEFAULT NULL,
  p_fallback TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE
    WHEN public.shipment_timeline_policy_gap_v1(p_summary) THEN 'Policy configuration needs review'
    WHEN p_event_source = 'outbound_communication'
      AND lower(COALESCE(p_error_message, p_summary, '')) LIKE '%invalid url%'
      THEN 'Communication provider endpoint needs configuration'
    WHEN p_event_source = 'outbound_communication'
      AND NULLIF(btrim(COALESCE(p_error_message, '')), '') IS NOT NULL
      THEN 'Communication delivery failed'
    WHEN p_response_status_code IS NOT NULL THEN format('HTTP %s', p_response_status_code)
    WHEN NULLIF(btrim(COALESCE(p_summary, '')), '') IS NOT NULL THEN p_summary
    ELSE NULLIF(btrim(COALESCE(p_fallback, '')), '')
  END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_get_shipment_timeline_v1(
  p_shipment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_can_read_shipments BOOLEAN := FALSE;
  v_can_read_executor_timeline BOOLEAN := FALSE;
  v_can_read_audit_log BOOLEAN := FALSE;
  v_can_read_requests BOOLEAN := FALSE;
  v_shipment public.shipments%ROWTYPE;
  v_correlation_ids UUID[] := ARRAY[]::uuid[];
  v_events JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_get_shipment_timeline_v1 requires authenticated user';
  END IF;
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_shipment_timeline_v1 requires shipment_id';
  END IF;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  v_can_read_shipments := public.user_has_capability_v1('shipments.read', v_scope_type, v_scope_id);
  IF COALESCE(v_can_read_shipments, FALSE) IS DISTINCT FROM TRUE THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.route_stops_visible_v1 rs
      WHERE rs.shipment_id = p_shipment_id
    )
      INTO v_can_read_executor_timeline;
  END IF;

  IF COALESCE(v_can_read_shipments, FALSE) IS DISTINCT FROM TRUE
     AND COALESCE(v_can_read_executor_timeline, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Capability denied: shipments.read' USING ERRCODE = '42501';
  END IF;

  v_can_read_audit_log := public.user_has_capability_v1('audit_log.read', v_scope_type, v_scope_id);
  v_can_read_requests := public.user_has_capability_v1('requests.read', v_scope_type, v_scope_id);

  SELECT s.*
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = p_shipment_id
     AND (
       public.is_platform_user()
       OR (
         COALESCE(v_can_read_shipments, FALSE) IS TRUE
         AND (
           (
             public.current_user_scope_type() = 'tenant'
             AND s.organization_id = public.current_user_org_id()
           )
           OR (
             public.current_user_scope_type() = 'client'
             AND s.client_id = public.current_user_client_id()
           )
           OR (
             public.current_user_scope_type() = 'sender'
             AND s.sender_id = public.current_user_sender_id()
           )
         )
       )
       OR (
         COALESCE(v_can_read_executor_timeline, FALSE) IS TRUE
         AND EXISTS (
           SELECT 1
           FROM public.route_stops_visible_v1 rs
           WHERE rs.shipment_id = s.id
         )
       )
     )
   LIMIT 1;

  IF v_shipment.id IS NULL THEN
    RAISE EXCEPTION 'Shipment % not found or inaccessible', p_shipment_id;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT wr.triggered_by_request_id), ARRAY[]::uuid[])
    INTO v_correlation_ids
    FROM public.workflow_runs wr
   WHERE wr.triggered_by_request_id IS NOT NULL
     AND (
       wr.context->>'shipment_id' = v_shipment.id::text
       OR wr.context->'shipment'->>'id' = v_shipment.id::text
       OR wr.context->'transformed_payload'->>'shipment_id' = v_shipment.id::text
     );

  SELECT COALESCE(jsonb_agg(to_jsonb(timeline_row) ORDER BY timeline_row.event_time DESC), '[]'::jsonb)
    INTO v_events
    FROM (
      SELECT
        sa.id AS event_id,
        'shipment_action'::text AS event_source,
        sa.action_type AS event_type,
        COALESCE(
          public.shipment_timeline_public_text_v1(sa.canonical_status),
          public.shipment_timeline_public_text_v1(sa.investigation_status),
          public.shipment_timeline_public_text_v1(sa.action_category)
        ) AS status,
        sa.timestamp AS event_time,
        NULL::uuid AS correlation_id,
        public.shipment_timeline_operator_summary_v1(
          'shipment_action',
          COALESCE(
            NULLIF(sa.delivery_attempt_reason, ''),
            NULLIF(sa.dispatch_exception_reason, ''),
            NULLIF(sa.notes, ''),
            NULLIF(sa.resolution, ''),
            NULLIF(sa.root_cause, ''),
            NULLIF(sa.canonical_status, ''),
            NULLIF(sa.action_category, '')
          ),
          NULL,
          NULL,
          sa.action_type
        ) AS summary,
        COALESCE(sa.performed_by_system, sa.performed_by_user_id::text) AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'action_category', public.shipment_timeline_public_text_v1(sa.action_category),
          'canonical_status', public.shipment_timeline_public_text_v1(sa.canonical_status),
          'location_type', sa.location_type,
          'requires_investigation', sa.requires_investigation,
          'investigation_status', public.shipment_timeline_public_text_v1(sa.investigation_status),
          'root_cause', public.shipment_timeline_public_text_v1(sa.root_cause),
          'resolution', public.shipment_timeline_public_text_v1(sa.resolution),
          'notes', public.shipment_timeline_public_text_v1(sa.notes),
          'policy_gap', CASE
            WHEN public.shipment_timeline_policy_gap_v1(sa.canonical_status)
              OR public.shipment_timeline_policy_gap_v1(sa.action_category)
              OR public.shipment_timeline_policy_gap_v1(sa.notes)
              OR public.shipment_timeline_policy_gap_v1(sa.root_cause)
              OR public.shipment_timeline_policy_gap_v1(sa.resolution)
            THEN TRUE
            ELSE NULL
          END,
          'delivery_attempt_outcome', sa.delivery_attempt_outcome,
          'delivery_attempt_reason', sa.delivery_attempt_reason,
          'dispatch_exception_reason', sa.dispatch_exception_reason,
          'delivery_attempt_ndr_action', sa.delivery_attempt_ndr_action,
          'delivery_attempt_count', sa.delivery_attempt_count,
          'delivery_attempt_eligible', sa.delivery_attempt_eligible,
          'delivery_attempted_at', sa.delivery_attempted_at,
          'route_stop_outcome', sa.route_stop_outcome
        )) AS metadata
      FROM public.shipment_actions sa
      WHERE sa.shipment_id = v_shipment.id

      UNION ALL

      SELECT
        dl.id AS event_id,
        'decision_log'::text AS event_source,
        dl.decision_category AS event_type,
        dl.decision_outcome AS status,
        dl.timestamp AS event_time,
        dl.correlation_id,
        public.shipment_timeline_operator_summary_v1(
          'decision_log',
          COALESCE(
            NULLIF(dl.decision_reason, ''),
            NULLIF(dl.decision_point, ''),
            NULLIF(dl.decision_category, '')
          ),
          NULL,
          NULL,
          dl.decision_category
        ) AS summary,
        dl.performed_by_system AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'decision_point', public.shipment_timeline_public_text_v1(dl.decision_point),
          'decision_reason', public.shipment_timeline_public_text_v1(dl.decision_reason),
          'policy_gap', CASE
            WHEN public.shipment_timeline_policy_gap_v1(dl.decision_point)
              OR public.shipment_timeline_policy_gap_v1(dl.decision_reason)
            THEN TRUE
            ELSE NULL
          END,
          'settings_resolution_id', dl.settings_resolution_id
        )) AS metadata
      FROM public.decision_log dl
      WHERE v_can_read_audit_log
        AND dl.organization_id = v_shipment.organization_id
        AND (
          (
            dl.resource_type = 'shipment'
            AND dl.resource_id = v_shipment.id
          )
          OR dl.correlation_id = ANY(v_correlation_ids)
        )

      UNION ALL

      SELECT
        de.id AS event_id,
        'domain_event'::text AS event_source,
        de.event_type,
        de.status,
        de.created_at AS event_time,
        de.correlation_id,
        public.shipment_timeline_operator_summary_v1(
          'domain_event',
          COALESCE(NULLIF(de.error_reason, ''), NULLIF(de.event_type, '')),
          NULL,
          NULL,
          de.event_type
        ) AS summary,
        NULL::text AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'workflow_run_id', de.workflow_run_id,
          'processed_at', de.processed_at,
          'error_reason', public.shipment_timeline_public_text_v1(de.error_reason),
          'policy_gap', CASE
            WHEN public.shipment_timeline_policy_gap_v1(de.error_reason) THEN TRUE
            ELSE NULL
          END
        )) AS metadata
      FROM public.domain_events de
      WHERE v_can_read_requests
        AND de.organization_id = v_shipment.organization_id
        AND de.resource_type = 'shipment'
        AND de.resource_id = v_shipment.id

      UNION ALL

      SELECT
        oc.id AS event_id,
        'outbound_communication'::text AS event_source,
        oc.call_type AS event_type,
        oc.status,
        COALESCE(oc.completed_at, oc.created_at) AS event_time,
        oc.correlation_id,
        public.shipment_timeline_operator_summary_v1(
          'outbound_communication',
          NULL,
          oc.error_message,
          oc.response_status_code,
          oc.call_type
        ) AS summary,
        oc.target_type AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'target_type', oc.target_type,
          'method', oc.method,
          'response_status_code', oc.response_status_code,
          'latency_ms', oc.latency_ms,
          'error_class', public.shipment_timeline_provider_error_class_v1(oc.error_message),
          'error_summary', public.shipment_timeline_operator_summary_v1(
            'outbound_communication',
            NULL,
            oc.error_message,
            oc.response_status_code,
            oc.call_type
          ),
          'completed_at', oc.completed_at
        )) AS metadata
      FROM public.outbound_calls oc
      WHERE oc.shipment_id = v_shipment.id
        AND oc.call_type IN (
          'client_webhook',
          'comms_sms',
          'comms_whatsapp',
          'comms_email',
          'comms_voice'
        )
    ) AS timeline_row;

  RETURN jsonb_build_object(
    'shipment_id', v_shipment.id,
    'timeline_events', v_events
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.shipment_timeline_policy_gap_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shipment_timeline_public_text_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shipment_timeline_provider_error_class_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shipment_timeline_operator_summary_v1(TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shipment_timeline_policy_gap_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shipment_timeline_public_text_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shipment_timeline_provider_error_class_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shipment_timeline_operator_summary_v1(TEXT, TEXT, TEXT, INTEGER, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_get_shipment_timeline_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_shipment_timeline_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_get_shipment_timeline_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_get_shipment_timeline_v1(
  p_shipment_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_get_shipment_timeline_v1(p_shipment_id);
$function$;

REVOKE ALL ON FUNCTION api.ui_get_shipment_timeline_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_get_shipment_timeline_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION api.ui_get_shipment_timeline_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_shipment_timeline_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606101230_console_v2_shipment_timeline_comms_action_readiness_v1'));
COMMIT;
