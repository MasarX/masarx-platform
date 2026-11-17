-- Spec-Issue: #2072 / Step: E01
-- Migration: Shipment timeline UI contract
-- Date: 2026-04-07
--
-- Purpose:
-- - Provide one shipment-scoped, UI-safe timeline that combines canonical shipment actions,
--   decisions, domain events, and outbound communications.
-- - Keep Console/Portal on the shipment-detail surface while preserving the api schema wrapper
--   contract for browser-facing RPC calls.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604071000_uc222_shipment_timeline_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

  PERFORM public.assert_capability_v1('shipments.read', v_scope_type, v_scope_id);
  v_can_read_audit_log := public.user_has_capability_v1('audit_log.read', v_scope_type, v_scope_id);
  v_can_read_requests := public.user_has_capability_v1('requests.read', v_scope_type, v_scope_id);

  SELECT s.*
    INTO v_shipment
    FROM public.shipments s
   WHERE s.id = p_shipment_id
     AND (
       public.is_platform_user()
       OR (
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
        COALESCE(sa.canonical_status, sa.investigation_status, sa.action_category) AS status,
        sa.timestamp AS event_time,
        NULL::uuid AS correlation_id,
        COALESCE(
          NULLIF(sa.notes, ''),
          NULLIF(sa.resolution, ''),
          NULLIF(sa.root_cause, ''),
          NULLIF(sa.canonical_status, ''),
          NULLIF(sa.action_category, '')
        ) AS summary,
        COALESCE(sa.performed_by_system, sa.performed_by_user_id::text) AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'action_category', sa.action_category,
          'canonical_status', sa.canonical_status,
          'location_type', sa.location_type,
          'requires_investigation', sa.requires_investigation,
          'investigation_status', sa.investigation_status,
          'root_cause', sa.root_cause,
          'resolution', sa.resolution,
          'notes', sa.notes
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
        COALESCE(
          NULLIF(dl.decision_reason, ''),
          NULLIF(dl.decision_point, ''),
          NULLIF(dl.decision_category, '')
        ) AS summary,
        dl.performed_by_system AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'decision_point', dl.decision_point,
          'decision_reason', dl.decision_reason,
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
        COALESCE(NULLIF(de.error_reason, ''), NULLIF(de.event_type, '')) AS summary,
        NULL::text AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'workflow_run_id', de.workflow_run_id,
          'processed_at', de.processed_at,
          'error_reason', de.error_reason
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
        COALESCE(
          NULLIF(oc.error_message, ''),
          CASE
            WHEN oc.response_status_code IS NOT NULL THEN format('HTTP %s', oc.response_status_code)
            ELSE NULL
          END,
          NULLIF(oc.call_type, '')
        ) AS summary,
        oc.target_type AS actor,
        jsonb_strip_nulls(jsonb_build_object(
          'target_type', oc.target_type,
          'method', oc.method,
          'response_status_code', oc.response_status_code,
          'latency_ms', oc.latency_ms,
          'error_message', oc.error_message,
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

REVOKE ALL ON FUNCTION public.ui_get_shipment_timeline_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_shipment_timeline_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_get_shipment_timeline_v1(UUID) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

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

SELECT pg_advisory_unlock(hashtext('202604071000_uc222_shipment_timeline_v1'));
COMMIT;
