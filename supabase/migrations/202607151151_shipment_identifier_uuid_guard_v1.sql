-- Shipment identifier UUID-correlation preflight guard.
--
-- Avoids scanning UUID-correlation relations for ordinary tracking, reference,
-- and phone searches while preserving the canonical, capability-gated lookup.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202607151151_shipment_identifier_uuid_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_search_shipment_identifier_ids_v1(
  p_queries TEXT[]
)
RETURNS UUID[]
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
  v_has_uuid_query BOOLEAN := FALSE;
  v_ids UUID[] := ARRAY[]::uuid[];
  v_correlation_ids UUID[] := ARRAY[]::uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ui_search_shipment_identifier_ids_v1 requires authenticated user';
  END IF;

  IF COALESCE(array_length(p_queries, 1), 0) = 0 THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := public.current_user_org_id();
  END IF;

  PERFORM public.assert_capability_v1('shipments.read', v_scope_type, v_scope_id);
  v_can_read_audit_log := public.user_has_capability_v1('audit_log.read', v_scope_type, v_scope_id);
  v_can_read_requests := public.user_has_capability_v1('requests.read', v_scope_type, v_scope_id);

  SELECT EXISTS (
    SELECT 1
      FROM unnest(COALESCE(p_queries, ARRAY[]::TEXT[])) AS query_text
     WHERE btrim(query_text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
    INTO v_has_uuid_query;

  WITH normalized_queries AS (
    SELECT DISTINCT
      btrim(query_text) AS raw_query,
      upper(NULLIF(btrim(query_text), '')) AS reference_upper,
      public.normalize_phone_number(query_text) AS phone_normalized,
      CASE
        WHEN btrim(query_text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN btrim(query_text)::uuid
        ELSE NULL::uuid
      END AS query_uuid
    FROM unnest(COALESCE(p_queries, ARRAY[]::TEXT[])) AS query_text
    WHERE NULLIF(btrim(query_text), '') IS NOT NULL
  ),
  visible_shipments AS (
    SELECT
      s.id,
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.recipient_id,
      s.tracking_upper,
      upper(NULLIF(btrim(s.client_reference_number), '')) AS client_reference_upper,
      upper(NULLIF(btrim(s.carrier_reference_number), '')) AS carrier_reference_upper,
      upper(NULLIF(btrim(s.lmd_system_reference), '')) AS lmd_reference_upper
    FROM public.shipments s
    WHERE public.is_platform_user()
       OR (
         v_scope_type = 'tenant'
         AND s.organization_id = v_scope_id
       )
       OR (
         v_scope_type = 'client'
         AND s.client_id = v_scope_id
       )
       OR (
         v_scope_type = 'sender'
         AND s.sender_id = v_scope_id
       )
  ),
  matched_shipments AS (
    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq
      ON (
        (nq.query_uuid IS NOT NULL AND vs.id = nq.query_uuid)
        OR (nq.reference_upper IS NOT NULL AND vs.tracking_upper = nq.reference_upper)
        OR (nq.reference_upper IS NOT NULL AND vs.client_reference_upper = nq.reference_upper)
        OR (nq.reference_upper IS NOT NULL AND vs.carrier_reference_upper = nq.reference_upper)
        OR (nq.reference_upper IS NOT NULL AND vs.lmd_reference_upper = nq.reference_upper)
      )

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN public.shipment_reference_numbers srn
      ON srn.shipment_id = vs.id
     AND srn.client_id = vs.client_id
    JOIN normalized_queries nq
      ON nq.reference_upper IS NOT NULL
     AND srn.reference_value_upper = nq.reference_upper

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN public.recipients r
      ON r.id = vs.recipient_id
     AND r.client_id = vs.client_id
    JOIN normalized_queries nq
      ON nq.phone_normalized IS NOT NULL
     AND r.phone_number_normalized = nq.phone_normalized
  )
  SELECT COALESCE(array_agg(matched_shipments.id ORDER BY matched_shipments.id), ARRAY[]::uuid[])
    INTO v_ids
    FROM matched_shipments;

  -- PL/pgSQL prepares statements lazily. Returning here keeps the correlation
  -- statement and its relation locks entirely off the non-UUID execution path.
  IF NOT v_has_uuid_query THEN
    RETURN COALESCE(v_ids, ARRAY[]::uuid[]);
  END IF;

  WITH normalized_queries AS (
    SELECT DISTINCT btrim(query_text)::uuid AS query_uuid
    FROM unnest(COALESCE(p_queries, ARRAY[]::TEXT[])) AS query_text
    WHERE btrim(query_text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  visible_shipments AS (
    SELECT
      s.id,
      s.organization_id
    FROM public.shipments s
    WHERE public.is_platform_user()
       OR (
         v_scope_type = 'tenant'
         AND s.organization_id = v_scope_id
       )
       OR (
         v_scope_type = 'client'
         AND s.client_id = v_scope_id
       )
       OR (
         v_scope_type = 'sender'
         AND s.sender_id = v_scope_id
       )
  ),
  matched_correlations AS (
    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq ON TRUE
    JOIN public.workflow_runs wr
      ON (v_can_read_audit_log OR v_can_read_requests)
     AND wr.triggered_by_request_id = nq.query_uuid
     AND (
       wr.context->>'shipment_id' = vs.id::text
       OR wr.context->'shipment'->>'id' = vs.id::text
       OR wr.context->'transformed_payload'->>'shipment_id' = vs.id::text
     )

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq ON TRUE
    JOIN public.decision_log dl
      ON v_can_read_audit_log
     AND dl.organization_id = vs.organization_id
     AND dl.correlation_id = nq.query_uuid
     AND (
       (dl.resource_type = 'shipment' AND dl.resource_id = vs.id)
       OR EXISTS (
         SELECT 1
         FROM public.workflow_runs wr
         WHERE wr.triggered_by_request_id = dl.correlation_id
           AND (
             wr.context->>'shipment_id' = vs.id::text
             OR wr.context->'shipment'->>'id' = vs.id::text
             OR wr.context->'transformed_payload'->>'shipment_id' = vs.id::text
           )
       )
     )

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq ON TRUE
    JOIN public.domain_events de
      ON v_can_read_requests
     AND de.organization_id = vs.organization_id
     AND de.correlation_id = nq.query_uuid
     AND de.resource_type = 'shipment'
     AND de.resource_id = vs.id

    UNION

    SELECT DISTINCT vs.id
    FROM visible_shipments vs
    JOIN normalized_queries nq ON TRUE
    JOIN public.outbound_calls oc
      ON (v_can_read_audit_log OR v_can_read_requests)
     AND oc.correlation_id = nq.query_uuid
     AND oc.shipment_id = vs.id
  )
  SELECT COALESCE(array_agg(matched_correlations.id ORDER BY matched_correlations.id), ARRAY[]::uuid[])
    INTO v_correlation_ids
    FROM matched_correlations;

  SELECT COALESCE(array_agg(DISTINCT matched_id ORDER BY matched_id), ARRAY[]::uuid[])
    INTO v_ids
    FROM unnest(
      COALESCE(v_ids, ARRAY[]::uuid[])
      || COALESCE(v_correlation_ids, ARRAY[]::uuid[])
    ) AS matched_id;

  RETURN COALESCE(v_ids, ARRAY[]::uuid[]);
END;
$function$;

COMMENT ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[])
  IS 'Resolve visible shipment ids for the authenticated caller from canonical shipment identifiers and capability-gated correlation ids; UUID-correlation branches are skipped for non-UUID queries.';

REVOKE ALL ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_search_shipment_identifier_ids_v1(TEXT[]) TO authenticated, service_role;

-- The three potentially large indexes are intentionally absent here. They are
-- built by scripts/ops/db/run-online-index-phase.js after this transactional
-- migration commits. PostgreSQL cannot run CREATE INDEX CONCURRENTLY inside a
-- transaction, and decision_log requires leaf-first concurrent builds followed
-- by bottom-up partitioned-index attachment.

COMMIT;
