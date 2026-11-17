-- Driver route loading only. Existing stop scan-out/departure semantics stay unchanged.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET search_path TO public, extensions, pg_temp;

-- No per-parcel cold-chain SSOT existed. NULL is unrecorded, never non-cold.
ALTER TABLE public.shipment_boxes ADD COLUMN cold_chain BOOLEAN;
COMMENT ON COLUMN public.shipment_boxes.cold_chain IS
  'Recorded parcel cold-chain requirement; NULL means unknown. Driver loading does not edit handling requirements.';

CREATE TABLE public.route_load_manifest_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  route_run_id UUID NOT NULL REFERENCES public.route_runs(id),
  route_stop_id UUID REFERENCES public.route_stops(id),
  shipment_box_id UUID REFERENCES public.shipment_boxes(id),
  actor_user_id UUID NOT NULL REFERENCES public.users(id),
  action TEXT NOT NULL CHECK (action IN ('mark_missing', 'undo_missing', 'report_discrepancy')),
  note TEXT CHECK (char_length(note) <= 1000),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (route_run_id, actor_user_id, idempotency_key),
  CHECK ((action = 'report_discrepancy' AND route_stop_id IS NULL AND shipment_box_id IS NULL AND NULLIF(btrim(note), '') IS NOT NULL)
    OR (action <> 'report_discrepancy' AND route_stop_id IS NOT NULL AND shipment_box_id IS NOT NULL))
);
CREATE INDEX route_load_manifest_actions_parcel_idx
  ON public.route_load_manifest_actions (route_run_id, route_stop_id, shipment_box_id, id DESC);
ALTER TABLE public.route_load_manifest_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY route_load_manifest_actions_service ON public.route_load_manifest_actions
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
REVOKE ALL ON public.route_load_manifest_actions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.route_load_manifest_actions TO service_role;
REVOKE ALL ON SEQUENCE public.route_load_manifest_actions_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SEQUENCE public.route_load_manifest_actions_id_seq TO service_role;
CREATE TRIGGER audit_row_change BEFORE INSERT OR UPDATE OR DELETE ON public.route_load_manifest_actions
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture_row_change();
INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns, redaction_token)
VALUES ('public', 'route_load_manifest_actions', 'denylist', ARRAY['note']::text[], '[REDACTED]');

CREATE FUNCTION public.route_load_manifest_v1(p_route_run_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp SET row_security = on
AS $function$
DECLARE
  v_route public.route_runs%ROWTYPE;
  v_parcels JSONB;
  v_scan_out JSONB;
  v_last_note TEXT;
BEGIN
  SELECT * INTO v_route FROM public.ui_route_run_visible_v1(p_route_run_id, 'read');
  v_scan_out := public.route_run_scan_out_reconciliation_v1(v_route.id);
  SELECT COALESCE(jsonb_agg(item.payload ORDER BY item.destination, item.barcode), '[]'::jsonb)
  INTO v_parcels FROM (
    SELECT rs.id::text AS destination, sb.barcode,
      jsonb_build_object(
        'route_stop_id', rs.id, 'shipment_box_id', sb.id, 'barcode', sb.barcode,
        'weight_kg', sb.weight_kg, 'cold_chain', sb.cold_chain,
        'status', CASE
          WHEN latest.action = 'mark_missing' AND (load_scan.received_at IS NULL OR load_scan.received_at <= latest.created_at) THEN 'missing'
          WHEN load_scan.received_at IS NOT NULL THEN 'scanned'
          ELSE 'pending' END,
        'reason', CASE WHEN latest.action = 'mark_missing' AND (load_scan.received_at IS NULL OR load_scan.received_at <= latest.created_at) THEN latest.note ELSE NULL END
      ) AS payload
    FROM public.route_stops rs
    JOIN public.shipments s ON s.id = rs.shipment_id AND s.client_id = rs.client_id AND s.organization_id = v_route.organization_id
    JOIN public.shipment_boxes sb ON sb.shipment_id = s.id AND sb.client_id = s.client_id AND sb.organization_id = s.organization_id
    LEFT JOIN LATERAL (
      SELECT MAX(se.received_at) AS received_at FROM public.scan_events se
      WHERE se.organization_id = v_route.organization_id AND se.route_run_id = v_route.id
        AND se.scan_type = 'load' AND upper(btrim(se.barcode)) = upper(sb.barcode)
        AND (se.route_stop_id IS NULL OR se.route_stop_id = rs.id)
    ) load_scan ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.action, a.note, a.created_at FROM public.route_load_manifest_actions a
      WHERE a.organization_id = v_route.organization_id AND a.route_run_id = v_route.id AND a.route_stop_id = rs.id AND a.shipment_box_id = sb.id
      ORDER BY a.id DESC LIMIT 1
    ) latest ON TRUE
    WHERE rs.route_run_id = v_route.id AND rs.organization_id = v_route.organization_id
    UNION ALL
    SELECT '~extra', barcode, jsonb_build_object(
      'route_stop_id', NULL, 'shipment_box_id', NULL, 'barcode', barcode,
      'weight_kg', NULL, 'cold_chain', NULL, 'status', 'extra', 'reason', NULL
    ) FROM (
      SELECT DISTINCT se.barcode FROM public.scan_events se
      WHERE se.organization_id = v_route.organization_id AND se.route_run_id = v_route.id
        AND se.id::text IN (SELECT jsonb_array_elements_text(COALESCE(v_scan_out->'unexpected_scan_event_ids', '[]'::jsonb)))
        AND NOT EXISTS (
          SELECT 1 FROM public.route_stops rs JOIN public.shipment_boxes sb
            ON sb.shipment_id = rs.shipment_id AND sb.client_id = rs.client_id AND sb.organization_id = rs.organization_id
          WHERE rs.route_run_id = v_route.id AND rs.organization_id = v_route.organization_id AND upper(sb.barcode) = upper(btrim(se.barcode))
        )
    ) extras
  ) item;
  SELECT note INTO v_last_note FROM public.route_load_manifest_actions
    WHERE organization_id = v_route.organization_id AND route_run_id = v_route.id AND action = 'report_discrepancy' ORDER BY id DESC LIMIT 1;
  RETURN jsonb_build_object(
    'parcels', v_parcels, 'last_discrepancy', v_last_note,
    'can_record_actions', auth.uid() IS NOT NULL
      AND lower(v_route.status) NOT IN ('completed', 'canceled')
      AND (v_route.driver_user_id = auth.uid() OR public.user_has_capability_v1('routes.write', public.current_user_scope_type(), COALESCE(public.current_user_scope_id(), public.current_user_org_id())))
      AND public.user_has_capability_v1('tasks.complete', public.current_user_scope_type(), COALESCE(public.current_user_scope_id(), public.current_user_org_id()))
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.route_load_manifest_v1(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.route_load_manifest_v1(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.ui_route_run_execution_manifest_v1(p_route_run_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE v_route public.route_runs%ROWTYPE; v_manifest JSONB; v_load_manifest JSONB;
BEGIN
  SELECT * INTO v_route FROM public.ui_route_run_visible_v1(p_route_run_id, 'read');
  v_manifest := public.route_run_execution_manifest_current_v1(v_route.id);
  IF v_manifest IS NULL THEN RETURN NULL; END IF;
  v_load_manifest := public.route_load_manifest_v1(v_route.id);
  -- Preserve the legacy manifest hash also exposed by api.route_runs.
  RETURN v_manifest || jsonb_build_object('load_manifest', v_load_manifest,
    'load_manifest_hash', public.route_plan_execution_pack_hash_v1(v_load_manifest));
END;
$function$;

CREATE FUNCTION public.ui_record_route_load_action_v1(p_input JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp SET row_security = on
AS $function$
DECLARE
  v_route public.route_runs%ROWTYPE;
  v_existing public.route_load_manifest_actions%ROWTYPE;
  v_actor UUID := auth.uid(); v_route_id UUID; v_stop_id UUID; v_box_id UUID;
  v_action TEXT; v_note TEXT; v_key TEXT; v_barcode TEXT; v_event_id BIGINT;
  v_scope TEXT := public.current_user_scope_type();
  v_scope_id UUID := COALESCE(public.current_user_scope_id(), public.current_user_org_id());
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'route_load_object_required' USING ERRCODE = '22023'; END IF;
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM (p_input->>'actor_user_id')::uuid THEN
    RAISE EXCEPTION 'route_load_actor_mismatch' USING ERRCODE = '42501';
  END IF;
  v_route_id := (p_input->>'route_run_id')::uuid;
  v_stop_id := NULLIF(p_input->>'route_stop_id', '')::uuid;
  v_box_id := NULLIF(p_input->>'shipment_box_id', '')::uuid;
  v_action := p_input->>'action'; v_note := NULLIF(btrim(p_input->>'note'), ''); v_key := btrim(p_input->>'idempotency_key');
  IF v_action IS NULL OR v_action NOT IN ('mark_missing', 'undo_missing', 'report_discrepancy')
    OR v_key IS NULL OR jsonb_typeof(p_input->'idempotency_key') <> 'string'
    OR char_length(v_key) NOT BETWEEN 1 AND 200 OR char_length(v_note) > 1000
    OR (p_input->'note' IS NOT NULL AND p_input->'note' <> 'null'::jsonb AND jsonb_typeof(p_input->'note') <> 'string') THEN
    RAISE EXCEPTION 'route_load_input_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_route FROM public.ui_route_run_visible_v1(v_route_id, 'read');
  SELECT * INTO v_route FROM public.route_runs WHERE id = v_route.id FOR UPDATE;
  IF v_route.organization_id IS DISTINCT FROM (p_input->>'organization_id')::uuid
    OR NOT public.route_run_actor_can_read_v1(v_route.organization_id, v_route.id, v_route.driver_user_id)
    OR (v_route.driver_user_id IS DISTINCT FROM v_actor AND NOT public.user_has_capability_v1('routes.write', v_scope, v_scope_id)) THEN
    RAISE EXCEPTION 'route_load_scope_denied' USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('tasks.complete', v_scope, v_scope_id);
  SELECT * INTO v_existing FROM public.route_load_manifest_actions
    WHERE organization_id = v_route.organization_id AND route_run_id = v_route.id AND actor_user_id = v_actor AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.action IS DISTINCT FROM v_action OR v_existing.note IS DISTINCT FROM v_note
      OR v_existing.route_stop_id IS DISTINCT FROM v_stop_id OR v_existing.shipment_box_id IS DISTINCT FROM v_box_id THEN
      RAISE EXCEPTION 'route_load_idempotency_conflict' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('event_id', v_existing.id, 'load_manifest', public.route_load_manifest_v1(v_route.id));
  END IF;
  IF lower(v_route.status) IN ('completed', 'canceled') THEN RAISE EXCEPTION 'route_load_terminal' USING ERRCODE = '23514'; END IF;
  IF v_action = 'report_discrepancy' THEN
    IF v_note IS NULL OR v_stop_id IS NOT NULL OR v_box_id IS NOT NULL THEN
      RAISE EXCEPTION 'route_load_discrepancy_note_required' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT sb.barcode INTO v_barcode FROM public.route_stops rs
    JOIN public.shipment_boxes sb ON sb.shipment_id = rs.shipment_id AND sb.client_id = rs.client_id AND sb.organization_id = rs.organization_id
    WHERE rs.id = v_stop_id AND rs.route_run_id = v_route.id AND rs.organization_id = v_route.organization_id AND sb.id = v_box_id;
    IF v_barcode IS NULL THEN RAISE EXCEPTION 'route_load_parcel_outside_route' USING ERRCODE = '42501'; END IF;
    IF v_action = 'mark_missing' AND EXISTS (
      SELECT 1 FROM public.scan_events se WHERE se.organization_id = v_route.organization_id AND se.route_run_id = v_route.id
        AND se.scan_type = 'load' AND upper(btrim(se.barcode)) = upper(v_barcode)
        AND (se.route_stop_id IS NULL OR se.route_stop_id = v_stop_id)
    ) THEN RAISE EXCEPTION 'route_load_parcel_already_scanned' USING ERRCODE = '23514'; END IF;
  END IF;
  INSERT INTO public.route_load_manifest_actions (organization_id, route_run_id, route_stop_id, shipment_box_id, actor_user_id, action, note, idempotency_key)
  VALUES (v_route.organization_id, v_route.id, v_stop_id, v_box_id, v_actor, v_action, v_note, v_key)
  RETURNING id INTO v_event_id;
  RETURN jsonb_build_object('event_id', v_event_id, 'load_manifest', public.route_load_manifest_v1(v_route.id));
END;
$function$;
REVOKE ALL ON FUNCTION public.ui_record_route_load_action_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_record_route_load_action_v1(JSONB) TO authenticated, service_role;
CREATE FUNCTION api.ui_record_route_load_action_v1(p_input JSONB)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path TO public, extensions, pg_temp
AS $function$ SELECT public.ui_record_route_load_action_v1(p_input); $function$;
REVOKE ALL ON FUNCTION api.ui_record_route_load_action_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_record_route_load_action_v1(JSONB) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
