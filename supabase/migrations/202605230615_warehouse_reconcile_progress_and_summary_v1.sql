-- Migration: Warehouse reconcile progress and summary readback v1
-- Date: 2026-05-23
--
-- Reconcile UI execution completes the active reconcile task under the operator
-- identity, then must wake service-only warehouse transfer workflow handlers.
-- Also keep the Console summary aligned with canonical receive metadata for
-- manifest/container scans that do not carry per-shipment scan_event links.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230615_warehouse_reconcile_progress_and_summary_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_old_decl TEXT := $$v_progress JSONB := '{}'::jsonb;$$;
  v_new_decl TEXT := $$v_progress JSONB := '{}'::jsonb;
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_elevated_claims JSONB;$$;
  v_old_progress TEXT := $$IF v_workflow_run_id IS NOT NULL THEN
    v_progress := COALESCE(
      public.progress_workflow_run(
        v_workflow_run_id,
        jsonb_build_object(
          'source', 'ui_execute_warehouse_transfer_reconcile_v1',
          'action_key', p_action_key,
          'resource_key', p_resource_key,
          'requested_by', v_user_id::text,
          'warehouse_transfer_id', v_transfer.id::text,
          'task_id', v_task.id::text,
          'task_event_id', v_existing_task_event_id::text
        )
      ),
      '{}'::jsonb
    );
  END IF;$$;
  v_new_progress TEXT := $$IF v_workflow_run_id IS NOT NULL THEN
    v_elevated_claims := jsonb_build_object(
      'role', 'service_role',
      'sub', v_user_id::text,
      'organization_id', v_transfer.organization_id::text,
      'access_scope_type', COALESCE(v_scope_type, 'tenant'),
      'origin', 'ui_execute_warehouse_transfer_reconcile_v1',
      'origin_scope_type', v_scope_type,
      'origin_scope_id', v_scope_id::text,
      'warehouse_transfer_id', v_transfer.id::text
    );

    BEGIN
      PERFORM set_config('request.jwt.claims', v_elevated_claims::text, true);

      v_progress := COALESCE(
        public.progress_workflow_run(
          v_workflow_run_id,
          jsonb_build_object(
            'source', 'ui_execute_warehouse_transfer_reconcile_v1',
            'action_key', p_action_key,
            'resource_key', p_resource_key,
            'requested_by', v_user_id::text,
            'warehouse_transfer_id', v_transfer.id::text,
            'task_id', v_task.id::text,
            'task_event_id', v_existing_task_event_id::text
          )
        ),
        '{}'::jsonb
      );

      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
    EXCEPTION
      WHEN others THEN
        PERFORM set_config('request.jwt.claims', v_prev_claims, true);
        RAISE;
    END;
  END IF;$$;
BEGIN
  SELECT pg_get_functiondef('public.ui_execute_warehouse_transfer_reconcile_v1(text, text, text[], text, integer, jsonb)'::regprocedure)
    INTO v_def;

  IF position('origin'', ''ui_execute_warehouse_transfer_reconcile_v1' IN v_def) = 0 THEN
    IF position(v_old_decl IN v_def) = 0 THEN
      RAISE EXCEPTION 'reconcile progress migration could not find declaration block';
    END IF;
    IF position(v_old_progress IN v_def) = 0 THEN
      RAISE EXCEPTION 'reconcile progress migration could not find progress block';
    END IF;

    v_def := replace(v_def, v_old_decl, v_new_decl);
    v_def := replace(v_def, v_old_progress, v_new_progress);
    EXECUTE v_def;
  END IF;
END;
$do$;

DROP VIEW IF EXISTS public.v_warehouse_transfer_summary;

CREATE VIEW public.v_warehouse_transfer_summary
  WITH (security_invoker = true)
AS
WITH item_counts AS (
  SELECT
    wti.transfer_id,
    COUNT(*) AS item_count
  FROM public.warehouse_transfer_items wti
  GROUP BY wti.transfer_id
),
receipt_counts AS (
  SELECT
    se.warehouse_transfer_id AS transfer_id,
    COUNT(DISTINCT se.shipment_id) AS received_count
  FROM public.scan_events se
  WHERE se.warehouse_transfer_id IS NOT NULL
    AND se.scan_type = 'warehouse_checkpoint'
    AND lower(COALESCE(se.metadata->>'checkpoint', '')) = 'destination_scan_in'
    AND se.shipment_id IS NOT NULL
  GROUP BY se.warehouse_transfer_id
),
projected AS (
  SELECT
    wt.*,
    COALESCE(ic.item_count, 0)::INT AS item_count,
    COALESCE(rc.received_count, 0)::INT AS scan_received_count,
    CASE
      WHEN COALESCE(wt.metadata #>> '{receive,received_shipment_count}', '') ~ '^[0-9]+$'
        THEN (wt.metadata #>> '{receive,received_shipment_count}')::INT
      ELSE NULL
    END AS receive_summary_count
  FROM public.warehouse_transfers wt
  LEFT JOIN item_counts ic ON ic.transfer_id = wt.id
  LEFT JOIN receipt_counts rc ON rc.transfer_id = wt.id
)
SELECT
  p.id,
  p.organization_id,
  p.transfer_code,
  p.from_branch_id,
  p.to_branch_id,
  p.status,
  p.dispatched_at,
  p.received_at,
  COALESCE(p.received_at, p.dispatched_at) AS posted_at,
  p.item_count,
  GREATEST(COALESCE(p.receive_summary_count, p.scan_received_count, 0), 0)::INT AS received_count,
  GREATEST(
    p.item_count - GREATEST(COALESCE(p.receive_summary_count, p.scan_received_count, 0), 0)::INT,
    0
  ) AS variance_count,
  (
    p.item_count > GREATEST(COALESCE(p.receive_summary_count, p.scan_received_count, 0), 0)
    AND p.status IN ('received', 'reconciled', 'on_hold')
  ) AS variance_flag,
  NULLIF(btrim(COALESCE(p.metadata->>'hold_reason', '')), '') AS hold_reason,
  p.created_at,
  p.updated_at
FROM projected p;

COMMENT ON VIEW public.v_warehouse_transfer_summary IS
  'FE-friendly projection of warehouse_transfers with derived aggregates. Received count prefers canonical receive phase metadata, falling back to shipment-linked destination scan events.';

REVOKE ALL ON public.v_warehouse_transfer_summary FROM PUBLIC;
REVOKE ALL ON public.v_warehouse_transfer_summary FROM anon;
REVOKE ALL ON public.v_warehouse_transfer_summary FROM authenticated;
GRANT SELECT ON public.v_warehouse_transfer_summary TO authenticated;
GRANT SELECT ON public.v_warehouse_transfer_summary TO service_role;

COMMENT ON FUNCTION public.ui_execute_warehouse_transfer_reconcile_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  IS 'Record destination reconcile task output and wake service-only warehouse transfer workflow transitions with a guarded service_role claim.';

SELECT pg_advisory_unlock(hashtext('202605230615_warehouse_reconcile_progress_and_summary_v1'));
COMMIT;
