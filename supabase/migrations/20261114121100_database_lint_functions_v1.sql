-- Use typed purge row identifiers and canonical workflow context ownership.
BEGIN;

CREATE OR REPLACE FUNCTION public.purge_log_retention_v1(
  p_targets jsonb DEFAULT '[
    {"rel":"public.audit_table_changes","ts":"created_at","keep":"30 days"},
    {"rel":"cron.job_run_details","ts":"start_time","keep":"7 days"},
    {"rel":"net._http_response","ts":"created","keep":"1 day"},
    {"rel":"public.request_contexts","ts":"started_at","keep":"7 days"}
  ]'::jsonb,
  p_batch integer DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '5s'
AS $$
DECLARE
  t jsonb;
  row_tableoid oid;
  row_ctid tid;
  deleted_count bigint;
  row_deleted bigint;
  skipped_fk_count bigint;
  target_errors jsonb;
  out jsonb := '{}'::jsonb;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'p_batch must be >= 1';
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    deleted_count := 0;
    skipped_fk_count := 0;
    target_errors := '[]'::jsonb;
    BEGIN
      EXECUTE format(
        'DELETE FROM %1$s WHERE (tableoid, ctid) IN (SELECT tableoid, ctid FROM %1$s WHERE %2$I < now() - $1::interval LIMIT $2)',
        (t->>'rel')::regclass, t->>'ts')
      USING t->>'keep', p_batch;
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
    EXCEPTION
      WHEN foreign_key_violation THEN
        BEGIN
          FOR row_tableoid, row_ctid IN EXECUTE format(
            'SELECT tableoid, ctid FROM %1$s WHERE %2$I < now() - $1::interval LIMIT $2',
            (t->>'rel')::regclass, t->>'ts')
          USING t->>'keep', p_batch LOOP
            BEGIN
              EXECUTE format('DELETE FROM %1$s WHERE tableoid = $1 AND ctid = $2', (t->>'rel')::regclass)
              USING row_tableoid, row_ctid;
              GET DIAGNOSTICS row_deleted = ROW_COUNT;
              deleted_count := deleted_count + row_deleted;
            EXCEPTION
              WHEN foreign_key_violation THEN
                skipped_fk_count := skipped_fk_count + 1;
              WHEN OTHERS THEN
                target_errors := target_errors || jsonb_build_array(jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
                EXIT;
            END;
          END LOOP;
        EXCEPTION
          WHEN OTHERS THEN
            target_errors := target_errors || jsonb_build_array(jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
        END;
      WHEN OTHERS THEN
        target_errors := target_errors || jsonb_build_array(jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
    END;
    out := out || jsonb_build_object(
      t->>'rel',
      jsonb_build_object('deleted', deleted_count, 'skipped_fk', skipped_fk_count, 'errors', target_errors));
  END LOOP;
  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_log_retention_v1(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_log_retention_v1(jsonb, integer) TO service_role;

COMMENT ON FUNCTION public.purge_log_retention_v1(jsonb, integer) IS
  'Returns one object per target with deleted and skipped_fk counts plus an errors array of sqlstate/message objects; target failures do not abort other targets.';

CREATE OR REPLACE FUNCTION public.ui_shipment_create_readback_v1(
  p_shipment_id UUID,
  p_workflow_run_id UUID DEFAULT NULL,
  p_correlation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_shipment JSONB;
  v_organization_id UUID;
  v_run_visible BOOLEAN;
  v_decision_visible BOOLEAN;
  v_audit_visible BOOLEAN;
BEGIN
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'shipment_id is required' USING ERRCODE = '23514';
  END IF;
  -- This existing read seam enforces the current registry capability and tenant/client/sender scope.
  v_shipment := public.ui_get_resource_v1('shipments', p_shipment_id);
  IF v_shipment IS NULL THEN
    RAISE EXCEPTION 'shipment is not visible' USING ERRCODE = '42501';
  END IF;
  v_organization_id := (v_shipment->>'organization_id')::UUID;

  -- Caller-supplied workflow/correlation ids must belong to this persisted shipment.
  SELECT EXISTS (
    SELECT 1 FROM public.workflow_runs w
    WHERE w.id = p_workflow_run_id AND w.context->>'organization_id' = v_organization_id::TEXT
      AND (w.context#>>'{shipment,id}' = p_shipment_id::TEXT
        OR w.context#>>'{workflow,context_patch,shipment,id}' = p_shipment_id::TEXT
        OR EXISTS (SELECT 1 FROM public.workflow_run_steps s WHERE s.workflow_run_id = w.id
          AND s.operation_result->>'shipment_id' = p_shipment_id::TEXT))
      AND (p_correlation_id IS NULL OR p_correlation_id IN (w.id, w.triggered_by_request_id))
  ) INTO v_run_visible;

  SELECT EXISTS (
    SELECT 1 FROM public.decision_log d
    WHERE d.organization_id = v_organization_id
      AND ((d.resource_type = 'shipment' AND d.resource_id = p_shipment_id)
        OR (v_run_visible AND d.resource_type = 'workflow_run' AND d.resource_id = p_workflow_run_id)
        OR (v_run_visible AND p_correlation_id IS NOT NULL AND d.correlation_id = p_correlation_id))
  ) INTO v_decision_visible;
  SELECT EXISTS (
    SELECT 1 FROM public.audit_table_changes a
    WHERE a.organization_id = v_organization_id
      AND a.table_name = 'shipments' AND a.pk @> jsonb_build_object('id', p_shipment_id)
  ) OR EXISTS (
    SELECT 1 FROM public.shipment_actions a
    WHERE a.organization_id = v_organization_id AND a.shipment_id = p_shipment_id
  ) INTO v_audit_visible;

  RETURN jsonb_build_object('visible', v_decision_visible AND v_audit_visible);
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_shipment_create_readback_v1(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_shipment_create_readback_v1(UUID, UUID, UUID) TO authenticated, service_role;

COMMIT;
