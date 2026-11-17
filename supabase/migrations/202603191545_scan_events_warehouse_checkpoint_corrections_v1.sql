-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S04
-- Migration: Scan events warehouse checkpoint sequencing + correction approvals v1
-- Date: 2026-03-19
--
-- Goals:
--   - Extend scan_policy with warehouse checkpoint sequencing and correction approval rules.
--   - Keep scan_events append-only: add correction linkage fields, do not mutate prior rows.
--   - Add a batch ingest RPC for bulk manifest/container capture.
--   - Preserve existing scan_event idempotency and policy resolution.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191545_scan_events_warehouse_checkpoint_corrections_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) scan_type lookup: add warehouse_checkpoint/correction scan types (idempotent)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('warehouse_checkpoint', 'Warehouse Checkpoint', 'Warehouse checkpoint scan', 25, FALSE, '{}' ),
  ('correction', 'Correction', 'Append-only correction event that references an original scan row', 70, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'scan_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) scan_policy schema + global default update
-------------------------------------------------------------------------------

UPDATE public.schema_registry
SET
  schema = jsonb_set(
    jsonb_set(
      jsonb_set(
        schema,
        '{properties,warehouse_checkpoint}',
        jsonb_build_object(
          'type', jsonb_build_array('object','null'),
          'additionalProperties', TRUE,
          'properties', jsonb_build_object(
            'enabled', jsonb_build_object('type', jsonb_build_array('boolean','null')),
            'sequence', jsonb_build_object(
              'type', jsonb_build_array('array','null'),
              'items', jsonb_build_object('type', 'string')
            ),
            'require_sequential_progression', jsonb_build_object('type', jsonb_build_array('boolean','null')),
            'allow_bulk', jsonb_build_object('type', jsonb_build_array('boolean','null'))
          )
        ),
        TRUE
      ),
      '{properties,correction}',
      jsonb_build_object(
        'type', jsonb_build_array('object','null'),
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'enabled', jsonb_build_object('type', jsonb_build_array('boolean','null')),
          'require_supervisor_approval', jsonb_build_object('type', jsonb_build_array('boolean','null')),
          'approval_task_type_key', jsonb_build_object('type', jsonb_build_array('string','null'))
        )
      ),
      TRUE
    ),
    '{properties,bulk}',
    jsonb_build_object(
      'type', jsonb_build_array('object','null'),
      'additionalProperties', TRUE,
      'properties', jsonb_build_object(
        'enabled', jsonb_build_object('type', jsonb_build_array('boolean','null')),
        'max_items', jsonb_build_object('type', jsonb_build_array('integer','null'), 'minimum', 0)
      )
    ),
    TRUE
  ),
  examples = CASE
    WHEN jsonb_typeof(examples) = 'array' THEN
      examples || jsonb_build_array(
        jsonb_build_object(
          'version', 1,
          'enabled', TRUE,
          'accepted_scan_types', jsonb_build_array('pickup','sort','warehouse_checkpoint','load','unload','delivery_attempt','delivered','correction'),
          'warehouse_checkpoint', jsonb_build_object(
            'enabled', TRUE,
            'sequence', jsonb_build_array('inbound','sort','load','unload','return'),
            'require_sequential_progression', TRUE,
            'allow_bulk', TRUE
          ),
          'correction', jsonb_build_object(
            'enabled', TRUE,
            'require_supervisor_approval', TRUE,
            'approval_task_type_key', 'warehouse_scan_supervisor_approval'
          ),
          'bulk', jsonb_build_object(
            'enabled', TRUE,
            'max_items', 50
          )
        )
      )
    ELSE examples
  END,
  updated_at = now()
WHERE category = 'scan_policy' AND version = 1;

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_settings_version_id UUID := NULL;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_accepted JSONB := '[]'::jsonb;
BEGIN
  SELECT sv.id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings_versions sv
    JOIN public.settings s ON s.settings_version_id = sv.id
   WHERE sv.category = 'scan_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL OR v_current IS NULL OR jsonb_typeof(v_current) <> 'object' THEN
    RAISE EXCEPTION 'scan_events_warehouse_checkpoint_corrections_v1: global scan_policy settings missing';
  END IF;

  v_accepted := COALESCE(v_current->'accepted_scan_types', '[]'::jsonb);
  IF jsonb_typeof(v_accepted) <> 'array' THEN
    v_accepted := '[]'::jsonb;
  END IF;
  IF NOT (v_accepted ? 'warehouse_checkpoint') THEN
    v_accepted := v_accepted || jsonb_build_array('warehouse_checkpoint');
  END IF;
  IF NOT (v_accepted ? 'correction') THEN
    v_accepted := v_accepted || jsonb_build_array('correction');
  END IF;

  v_next := public.jsonb_deep_merge(
    v_current,
    jsonb_build_object(
      'accepted_scan_types', v_accepted,
      'warehouse_checkpoint', jsonb_build_object(
        'enabled', TRUE,
        'sequence', jsonb_build_array('inbound','sort','load','unload','return'),
        'require_sequential_progression', TRUE,
        'allow_bulk', TRUE
      ),
      'correction', jsonb_build_object(
        'enabled', TRUE,
        'require_supervisor_approval', TRUE,
        'approval_task_type_key', 'warehouse_scan_supervisor_approval'
      ),
      'bulk', jsonb_build_object(
        'enabled', TRUE,
        'max_items', 50
      )
    )
  );

  IF v_next IS DISTINCT FROM v_current THEN
    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now()
     WHERE id = v_settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE settings_version_id = v_settings_version_id;
  END IF;
END;
$do$;

-------------------------------------------------------------------------------
-- 3) task_type_catalog: add warehouse_scan_supervisor_approval
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_items JSONB := '[]'::jsonb;
  v_item JSONB;
  v_found BOOLEAN := FALSE;
  v_settings_version_id UUID := NULL;
BEGIN
  SELECT sv.id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings_versions sv
    JOIN public.settings s ON s.settings_version_id = sv.id
   WHERE sv.category = 'task_type_catalog'
     AND sv.scope_type = 'global'
     AND sv.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_settings_version_id IS NULL OR v_current IS NULL OR jsonb_typeof(v_current) <> 'object' THEN
    RAISE EXCEPTION 'scan_events_warehouse_checkpoint_corrections_v1: global task_type_catalog settings missing';
  END IF;

  v_items := COALESCE(v_current->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_items) <> 'array' THEN
    v_items := '[]'::jsonb;
  END IF;

  FOR v_item IN
    SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    IF lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), '')) = 'warehouse_scan_supervisor_approval' THEN
      v_found := TRUE;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_found THEN
    v_items := v_items || jsonb_build_array(
      jsonb_build_object(
        'key', 'warehouse_scan_supervisor_approval',
        'name', 'Warehouse Scan Supervisor Approval',
        'description', 'Supervisor approval for append-only scan corrections.',
        'default_priority', 50,
        'default_queue_key', 'warehouse',
        'enabled', TRUE
      )
    );
    v_next := jsonb_set(v_current, '{task_types}', v_items, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now()
     WHERE id = v_settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE settings_version_id = v_settings_version_id;
  END IF;
END;
$do$;

-------------------------------------------------------------------------------
-- 4) Schema: scan_events correction + checkpoint columns
-------------------------------------------------------------------------------

ALTER TABLE public.scan_events
  ADD COLUMN IF NOT EXISTS checkpoint_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS checkpoint_sequence INT NULL,
  ADD COLUMN IF NOT EXISTS correction_of_scan_event_id UUID NULL,
  ADD COLUMN IF NOT EXISTS correction_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS correction_approval_task_id UUID NULL;

ALTER TABLE public.scan_events
  DROP CONSTRAINT IF EXISTS scan_events_checkpoint_key_ck;

ALTER TABLE public.scan_events
  ADD CONSTRAINT scan_events_checkpoint_key_ck CHECK (checkpoint_key IS NULL OR btrim(checkpoint_key) <> '');

ALTER TABLE public.scan_events
  DROP CONSTRAINT IF EXISTS scan_events_checkpoint_sequence_ck;

ALTER TABLE public.scan_events
  ADD CONSTRAINT scan_events_checkpoint_sequence_ck CHECK (checkpoint_sequence IS NULL OR checkpoint_sequence >= 1);

ALTER TABLE public.scan_events
  DROP CONSTRAINT IF EXISTS scan_events_correction_of_scan_event_self_ck;

ALTER TABLE public.scan_events
  ADD CONSTRAINT scan_events_correction_of_scan_event_self_ck CHECK (correction_of_scan_event_id IS NULL OR correction_of_scan_event_id <> id);

ALTER TABLE public.scan_events
  DROP CONSTRAINT IF EXISTS scan_events_correction_reason_ck;

ALTER TABLE public.scan_events
  ADD CONSTRAINT scan_events_correction_reason_ck CHECK (correction_of_scan_event_id IS NULL OR btrim(COALESCE(correction_reason, '')) <> '');

ALTER TABLE public.scan_events
  DROP CONSTRAINT IF EXISTS scan_events_correction_approval_task_id_ck;

ALTER TABLE public.scan_events
  ADD CONSTRAINT scan_events_correction_approval_task_id_ck CHECK (correction_approval_task_id IS NULL OR correction_of_scan_event_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_scan_events_checkpoint_time
  ON public.scan_events (organization_id, checkpoint_key, captured_at DESC)
  WHERE checkpoint_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scan_events_correction_origin
  ON public.scan_events (organization_id, correction_of_scan_event_id, captured_at DESC)
  WHERE correction_of_scan_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scan_events_correction_approval_task
  ON public.scan_events (organization_id, correction_approval_task_id)
  WHERE correction_approval_task_id IS NOT NULL;

-------------------------------------------------------------------------------
-- 5) Batch RPC: record_scan_events_batch_v1
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_scan_events_batch_v1(
  p_input JSONB
)
RETURNS TABLE (
  item_index INT,
  scan_event_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_input, '{}'::jsonb);
  v_manifest_barcode TEXT := NULLIF(btrim(COALESCE(v_in->>'bulk_manifest_barcode', v_in->>'manifest_barcode', '')), '');
  v_scans JSONB := '[]'::jsonb;
  v_item JSONB;
  v_idx INT := 0;
  v_item_input JSONB := '{}'::jsonb;
  v_item_meta JSONB := '{}'::jsonb;
  v_result RECORD;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_scan_policy RECORD;
  v_bulk_policy JSONB := '{}'::jsonb;
  v_max_items INT := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'record_scan_events_batch_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_events_batch_v1 could not resolve organization_id';
  END IF;

  IF jsonb_typeof(v_in) = 'array' THEN
    v_scans := v_in;
  ELSIF jsonb_typeof(v_in) = 'object' THEN
    v_scans := COALESCE(v_in->'scans', '[]'::jsonb);
  ELSE
    RAISE EXCEPTION 'record_scan_events_batch_v1 expects JSON object or array input' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_scans) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'record_scan_events_batch_v1 expects scans array' USING ERRCODE = '23514';
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org,
    'user_id', v_user,
    'event_type', 'scan_event'
  ));

  SELECT * INTO v_scan_policy FROM public.resolve_scan_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_scan_policy.value IS NOT NULL THEN
    v_bulk_policy := COALESCE(v_scan_policy.value->'bulk', '{}'::jsonb);
    IF COALESCE((v_bulk_policy->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_scan_events_batch_v1 blocked by scan_policy.bulk.enabled=false' USING ERRCODE = '42501';
    END IF;

    BEGIN v_max_items := NULLIF(v_bulk_policy->>'max_items', '')::int; EXCEPTION WHEN others THEN v_max_items := NULL; END;
    IF v_max_items IS NOT NULL AND jsonb_array_length(v_scans) > v_max_items THEN
      RAISE EXCEPTION 'record_scan_events_batch_v1 exceeds scan_policy.bulk.max_items' USING ERRCODE = '23514';
    END IF;
  END IF;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_scans) AS t(value)
  LOOP
    v_idx := v_idx + 1;
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'record_scan_events_batch_v1 expects each scan item to be an object' USING ERRCODE = '23514';
    END IF;

    v_item_meta := COALESCE(v_item->'metadata', '{}'::jsonb);
    IF jsonb_typeof(v_item_meta) IS DISTINCT FROM 'object' THEN
      v_item_meta := '{}'::jsonb;
    END IF;
    IF v_manifest_barcode IS NOT NULL THEN
      v_item_meta := public.jsonb_deep_merge(
        v_item_meta,
        jsonb_build_object('bulk_manifest_barcode', v_manifest_barcode)
      );
    END IF;

    v_item_input := public.jsonb_deep_merge(
      v_item,
      jsonb_build_object('metadata', v_item_meta)
    );

    SELECT * INTO v_result
    FROM public.record_scan_event_v1(v_item_input)
    LIMIT 1;

    item_index := v_idx;
    scan_event_id := v_result.scan_event_id;
    created := v_result.created;
    RETURN NEXT;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.record_scan_events_batch_v1(JSONB)
  IS 'Append-only batch wrapper for record_scan_event_v1; merges a manifest barcode into each scan metadata payload when provided.';
REVOKE ALL ON FUNCTION public.record_scan_events_batch_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_scan_events_batch_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_scan_events_batch_v1(JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.record_scan_events_batch_v1(
  p_input JSONB
)
RETURNS TABLE (
  item_index INT,
  scan_event_id UUID,
  created BOOLEAN
)
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT * FROM public.record_scan_events_batch_v1($1);
$function$;

COMMENT ON FUNCTION api.record_scan_events_batch_v1(JSONB)
  IS 'API-schema wrapper for public.record_scan_events_batch_v1 used by FieldOps mobile clients pinned to db.schema=api.';
REVOKE ALL ON FUNCTION api.record_scan_events_batch_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.record_scan_events_batch_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.record_scan_events_batch_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 6) RPC: record_scan_event_v1 with warehouse checkpoint sequencing + corrections
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_scan_event_v1(
  p_scan JSONB
)
RETURNS TABLE (
  scan_event_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_in JSONB := COALESCE(p_scan, '{}'::jsonb);
  v_id UUID := gen_random_uuid();
  v_created BOOLEAN := TRUE;

  v_device_id UUID := NULL;
  v_run_id UUID := NULL;
  v_stop_id UUID := NULL;
  v_ops_session_id UUID := NULL;
  v_branch_id UUID := NULL;
  v_client_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_artifact_id UUID := NULL;
  v_handling_unit_id UUID := NULL;
  v_handling_unit_code TEXT := NULL;
  v_transfer_id UUID := NULL;
  v_transfer_code TEXT := NULL;

  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_in->>'idempotency_key', '')), '');
  v_meta JSONB := '{}'::jsonb;
  v_store_meta JSONB := '{}'::jsonb;

  v_scan_type TEXT := NULL;
  v_barcode TEXT := NULL;
  v_checkpoint_key TEXT := NULL;
  v_checkpoint_sequence INT := NULL;
  v_previous_checkpoint_sequence INT := NULL;
  v_correction_of_scan_event_id UUID := NULL;
  v_correction_reason TEXT := NULL;
  v_correction_approval_task_id UUID := NULL;

  v_lat DOUBLE PRECISION := NULL;
  v_lng DOUBLE PRECISION := NULL;
  v_accuracy INT := NULL;
  v_captured_at TIMESTAMPTZ := NULL;

  v_policy_ctx JSONB;
  v_ingest RECORD;
  v_scan_policy RECORD;
  v_require_device BOOLEAN := NULL;
  v_max_payload INT := NULL;
  v_allowed JSONB := NULL;

  v_scan_policy_value JSONB := '{}'::jsonb;
  v_warehouse_checkpoint_policy JSONB := '{}'::jsonb;
  v_correction_policy JSONB := '{}'::jsonb;
  v_bulk_policy JSONB := '{}'::jsonb;
  v_policy_settings_resolution_id UUID := NULL;

  v_chain_scope TEXT := NULL;
  v_original_scan_type TEXT := NULL;
  v_approval_task_type_key TEXT := NULL;
  v_approval_task RECORD;
  v_decision_id UUID := NULL;
  v_decision_outcome TEXT := 'accepted';
  v_existing_scan_event_id UUID := NULL;
  v_ops_session_org UUID := NULL;
  v_ops_session_branch_id UUID := NULL;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires an authenticated user';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 could not resolve organization_id';
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'record_scan_event_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  SELECT d.scan_event_id
    INTO v_existing_scan_event_id
    FROM public.scan_event_dedupe d
   WHERE d.organization_id = v_org
     AND d.idempotency_key = v_idempotency
   LIMIT 1;

  IF v_existing_scan_event_id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_scan_event_id, FALSE;
    RETURN;
  END IF;

  v_scan_type := lower(NULLIF(btrim(COALESCE(v_in->>'scan_type', '')), ''));
  v_barcode := NULLIF(btrim(COALESCE(v_in->>'barcode', '')), '');

  IF v_scan_type IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires scan_type' USING ERRCODE = '23514';
  END IF;
  IF v_barcode IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires barcode' USING ERRCODE = '23514';
  END IF;

  BEGIN v_device_id := NULLIF(v_in->>'device_id', '')::uuid; EXCEPTION WHEN others THEN v_device_id := NULL; END;
  BEGIN v_run_id := NULLIF(v_in->>'route_run_id', '')::uuid; EXCEPTION WHEN others THEN v_run_id := NULL; END;
  BEGIN v_stop_id := NULLIF(v_in->>'route_stop_id', '')::uuid; EXCEPTION WHEN others THEN v_stop_id := NULL; END;
  BEGIN v_ops_session_id := NULLIF(v_in->>'ops_session_id', '')::uuid; EXCEPTION WHEN others THEN v_ops_session_id := NULL; END;
  BEGIN v_branch_id := NULLIF(v_in->>'branch_id', '')::uuid; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_in->>'client_id', '')::uuid; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_shipment_id := NULLIF(v_in->>'shipment_id', '')::uuid; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_artifact_id := NULLIF(v_in->>'artifact_id', '')::uuid; EXCEPTION WHEN others THEN v_artifact_id := NULL; END;
  BEGIN v_handling_unit_id := NULLIF(v_in->>'handling_unit_id', '')::uuid; EXCEPTION WHEN others THEN v_handling_unit_id := NULL; END;
  BEGIN v_transfer_id := NULLIF(v_in->>'warehouse_transfer_id', '')::uuid; EXCEPTION WHEN others THEN v_transfer_id := NULL; END;
  BEGIN v_checkpoint_key := lower(NULLIF(btrim(COALESCE(v_in->>'checkpoint_key', v_in->>'warehouse_checkpoint_key', v_in->'metadata'->>'checkpoint_key', v_in->'metadata'->>'warehouse_checkpoint_key', '')), '')); EXCEPTION WHEN others THEN v_checkpoint_key := NULL; END;
  BEGIN v_correction_of_scan_event_id := NULLIF(btrim(COALESCE(v_in->>'correction_of_scan_event_id', v_in->'metadata'->>'correction_of_scan_event_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_correction_of_scan_event_id := NULL; END;
  v_correction_reason := NULLIF(btrim(COALESCE(v_in->>'correction_reason', v_in->'metadata'->>'correction_reason', v_in->'metadata'->>'reason', '')), '');
  BEGIN v_correction_approval_task_id := NULLIF(btrim(COALESCE(v_in->>'correction_approval_task_id', v_in->'metadata'->>'correction_approval_task_id', '')), '')::uuid; EXCEPTION WHEN others THEN v_correction_approval_task_id := NULL; END;

  v_handling_unit_code := NULLIF(btrim(COALESCE(v_in->>'handling_unit_code', '')), '');
  v_transfer_code := NULLIF(btrim(COALESCE(v_in->>'warehouse_transfer_code', '')), '');

  BEGIN v_lat := NULLIF(v_in->>'lat', '')::double precision; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(v_in->>'lng', '')::double precision; EXCEPTION WHEN others THEN v_lng := NULL; END;
  BEGIN v_accuracy := NULLIF(v_in->>'accuracy_m', '')::int; EXCEPTION WHEN others THEN v_accuracy := NULL; END;
  BEGIN v_captured_at := NULLIF(v_in->>'captured_at', '')::timestamptz; EXCEPTION WHEN others THEN v_captured_at := NULL; END;

  IF (v_lat IS NULL) IS DISTINCT FROM (v_lng IS NULL) THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires both lat and lng when providing coordinates' USING ERRCODE = '23514';
  END IF;

  IF v_captured_at IS NULL THEN
    v_captured_at := now();
  END IF;

  v_meta := COALESCE(v_in->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_meta) <> 'object' THEN v_meta := '{}'::jsonb; END IF;

  -- Optional: derive shipment/client from route_stop if provided.
  IF v_stop_id IS NOT NULL THEN
    DECLARE
      v_stop_org UUID;
      v_stop_client UUID;
      v_stop_ship UUID;
      v_stop_run UUID;
    BEGIN
      SELECT rs.organization_id, rs.client_id, rs.shipment_id, rs.route_run_id
        INTO v_stop_org, v_stop_client, v_stop_ship, v_stop_run
        FROM public.route_stops rs
       WHERE rs.id = v_stop_id;

      IF v_stop_org IS NULL THEN
        RAISE EXCEPTION 'record_scan_event_v1 route_stop_id % not found', v_stop_id USING ERRCODE = '23503';
      END IF;
      IF v_stop_org IS DISTINCT FROM v_org THEN
        RAISE EXCEPTION 'record_scan_event_v1: organization mismatch (event org %, route_stop org %)', v_org, v_stop_org
          USING ERRCODE = '23514';
      END IF;

      IF v_client_id IS NULL AND v_shipment_id IS NULL THEN
        v_client_id := v_stop_client;
        v_shipment_id := v_stop_ship;
      ELSIF v_client_id IS NOT NULL AND v_shipment_id IS NOT NULL THEN
        IF v_client_id IS DISTINCT FROM v_stop_client OR v_shipment_id IS DISTINCT FROM v_stop_ship THEN
          RAISE EXCEPTION 'record_scan_event_v1: shipment mismatch vs route_stop' USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'record_scan_event_v1 requires both shipment_id and client_id when linking to a shipment' USING ERRCODE = '23514';
      END IF;

      IF v_run_id IS NULL THEN
        v_run_id := v_stop_run;
      ELSIF v_run_id IS DISTINCT FROM v_stop_run THEN
        RAISE EXCEPTION 'record_scan_event_v1: route_run_id mismatch vs route_stop' USING ERRCODE = '23514';
      END IF;
    END;
  END IF;

  IF v_ops_session_id IS NOT NULL THEN
    SELECT s.organization_id, s.branch_id
      INTO v_ops_session_org, v_ops_session_branch_id
      FROM public.ops_sessions s
     WHERE s.id = v_ops_session_id
     LIMIT 1;

    IF v_ops_session_org IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: ops_session_id not found for org' USING ERRCODE = '23503';
    END IF;
    IF v_ops_session_org IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'record_scan_event_v1: organization mismatch (event org %, ops session org %)', v_org, v_ops_session_org
        USING ERRCODE = '23514';
    END IF;

    IF v_branch_id IS NULL THEN
      v_branch_id := v_ops_session_branch_id;
    ELSIF v_ops_session_branch_id IS NOT NULL AND v_branch_id IS DISTINCT FROM v_ops_session_branch_id THEN
      RAISE EXCEPTION 'record_scan_event_v1: branch_id mismatch vs ops_session' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Optional: when not linked via route_stop and no shipment/client provided, try to resolve by barcode (tracking number).
  IF v_stop_id IS NULL AND v_client_id IS NULL AND v_shipment_id IS NULL THEN
    DECLARE
      v_tracking_upper TEXT;
    BEGIN
      v_tracking_upper := upper(NULLIF(btrim(split_part(v_barcode, ':', 1)), ''));
      IF v_tracking_upper IS NOT NULL THEN
        SELECT s.client_id, s.id, s.sender_id
          INTO v_client_id, v_shipment_id, v_sender_id
          FROM public.shipments s
         WHERE s.organization_id = v_org
           AND s.tracking_upper = v_tracking_upper
         LIMIT 1;
      END IF;
    END;
  END IF;

  -- Optional: resolve handling_unit / transfer by explicit id/code first, else barcode match (best-effort).
  IF v_handling_unit_id IS NULL AND v_handling_unit_code IS NOT NULL THEN
    SELECT hu.id
      INTO v_handling_unit_id
      FROM public.handling_units hu
     WHERE hu.organization_id = v_org
       AND hu.code = v_handling_unit_code
     LIMIT 1;
    IF v_handling_unit_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: handling_unit_code not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_handling_unit_id IS NOT NULL THEN
    PERFORM 1
      FROM public.handling_units hu
     WHERE hu.id = v_handling_unit_id
       AND hu.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: handling_unit_id not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_client_id IS NULL AND v_shipment_id IS NULL THEN
    SELECT hu.id
      INTO v_handling_unit_id
      FROM public.handling_units hu
     WHERE hu.organization_id = v_org
       AND hu.code = v_barcode
     LIMIT 1;
  END IF;

  IF v_transfer_id IS NULL AND v_transfer_code IS NOT NULL THEN
    SELECT wt.id
      INTO v_transfer_id
      FROM public.warehouse_transfers wt
     WHERE wt.organization_id = v_org
       AND wt.transfer_code = v_transfer_code
     LIMIT 1;
    IF v_transfer_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: warehouse_transfer_code not found for org' USING ERRCODE = '23503';
    END IF;
  ELSIF v_transfer_id IS NOT NULL THEN
    PERFORM 1
      FROM public.warehouse_transfers wt
     WHERE wt.id = v_transfer_id
       AND wt.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: warehouse_transfer_id not found for org' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF (v_shipment_id IS NULL) IS DISTINCT FROM (v_client_id IS NULL) THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires both shipment_id and client_id when linking to a shipment' USING ERRCODE = '23514';
  END IF;

  IF v_client_id IS NOT NULL THEN
    PERFORM 1 FROM public.clients c WHERE c.id = v_client_id AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record_scan_event_v1: client not found for org' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF v_client_id IS NOT NULL AND v_shipment_id IS NOT NULL THEN
    IF v_sender_id IS NULL THEN
      SELECT s.sender_id INTO v_sender_id
      FROM public.shipments s
      WHERE s.id = v_shipment_id
        AND s.client_id = v_client_id
        AND s.organization_id = v_org;
    END IF;
    IF v_sender_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1: shipment not found for client/org' USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Resolve ingest/scan policies (ladder-resolved; branch-aware via resource_id=branch_id when available).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org,
    'user_id', v_user,
    'resource_id', v_branch_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id,
    'event_type', 'scan_event'
  ));

  SELECT * INTO v_ingest FROM public.resolve_mobile_ingest_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_ingest.value IS NOT NULL THEN
    IF COALESCE((v_ingest.value->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by mobile_ingest_policy.enabled=false' USING ERRCODE = '42501';
    END IF;

    v_require_device := NULLIF(v_ingest.value->>'require_device', '')::boolean;
    IF COALESCE(v_require_device, FALSE) IS TRUE AND v_device_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1 requires device_id by policy' USING ERRCODE = '42501';
    END IF;

    BEGIN v_max_payload := NULLIF(v_ingest.value->>'max_payload_bytes', '')::int; EXCEPTION WHEN others THEN v_max_payload := NULL; END;
    IF v_max_payload IS NOT NULL AND octet_length(v_in::text) > v_max_payload THEN
      RAISE EXCEPTION 'record_scan_event_v1 payload too large for policy' USING ERRCODE = '22001';
    END IF;

    v_allowed := v_ingest.value->'accepted_event_types';
    IF jsonb_typeof(v_allowed) = 'array' AND NOT (v_allowed ? 'scan_event') THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by mobile_ingest_policy.accepted_event_types' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_scan_policy FROM public.resolve_scan_policy(v_policy_ctx) LIMIT 1;
  IF FOUND AND v_scan_policy.value IS NOT NULL THEN
    v_policy_settings_resolution_id := v_scan_policy.settings_id;
    v_scan_policy_value := COALESCE(v_scan_policy.value, '{}'::jsonb);
    IF COALESCE((v_scan_policy_value->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.enabled=false' USING ERRCODE = '42501';
    END IF;

    v_allowed := v_scan_policy_value->'accepted_scan_types';
    IF jsonb_typeof(v_allowed) = 'array' AND NOT (v_allowed ? v_scan_type) THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.accepted_scan_types' USING ERRCODE = '42501';
    END IF;

    v_warehouse_checkpoint_policy := COALESCE(v_scan_policy_value->'warehouse_checkpoint', '{}'::jsonb);
    IF jsonb_typeof(v_warehouse_checkpoint_policy) <> 'object' THEN
      v_warehouse_checkpoint_policy := '{}'::jsonb;
    END IF;

    v_correction_policy := COALESCE(v_scan_policy_value->'correction', '{}'::jsonb);
    IF jsonb_typeof(v_correction_policy) <> 'object' THEN
      v_correction_policy := '{}'::jsonb;
    END IF;

    v_bulk_policy := COALESCE(v_scan_policy_value->'bulk', '{}'::jsonb);
    IF jsonb_typeof(v_bulk_policy) <> 'object' THEN
      v_bulk_policy := '{}'::jsonb;
    END IF;
  END IF;

  v_store_meta := v_meta;

  IF v_scan_type = 'warehouse_checkpoint' THEN
    IF COALESCE((v_warehouse_checkpoint_policy->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.warehouse_checkpoint.enabled=false' USING ERRCODE = '42501';
    END IF;

    IF v_checkpoint_key IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1 requires checkpoint_key for warehouse_checkpoint scans' USING ERRCODE = '23514';
    END IF;

    SELECT seq.ordinality::int
      INTO v_checkpoint_sequence
      FROM jsonb_array_elements_text(COALESCE(v_warehouse_checkpoint_policy->'sequence', '[]'::jsonb)) WITH ORDINALITY AS seq(value, ordinality)
     WHERE lower(btrim(seq.value)) = v_checkpoint_key
     LIMIT 1;

    IF v_checkpoint_sequence IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1 invalid checkpoint_key for warehouse_checkpoint sequence: %', v_checkpoint_key
        USING ERRCODE = '23514';
    END IF;

    IF v_handling_unit_id IS NOT NULL THEN
      v_chain_scope := 'handling_unit';
    ELSIF v_transfer_id IS NOT NULL THEN
      v_chain_scope := 'warehouse_transfer';
    ELSIF v_shipment_id IS NOT NULL THEN
      v_chain_scope := 'shipment';
    ELSE
      v_chain_scope := 'barcode';
    END IF;

    SELECT se.checkpoint_sequence
      INTO v_previous_checkpoint_sequence
      FROM public.scan_events se
     WHERE se.organization_id = v_org
       AND se.scan_type = 'warehouse_checkpoint'
       AND se.checkpoint_sequence IS NOT NULL
       AND (
         (v_chain_scope = 'handling_unit' AND se.handling_unit_id = v_handling_unit_id)
         OR (v_chain_scope = 'warehouse_transfer' AND se.warehouse_transfer_id = v_transfer_id)
         OR (v_chain_scope = 'shipment' AND se.shipment_id = v_shipment_id)
         OR (v_chain_scope = 'barcode' AND se.barcode = v_barcode)
       )
     ORDER BY se.checkpoint_sequence DESC, se.captured_at DESC, se.created_at DESC, se.id DESC
     LIMIT 1;

    IF v_previous_checkpoint_sequence IS NULL THEN
      IF v_checkpoint_sequence <> 1 THEN
        RAISE EXCEPTION 'record_scan_event_v1 invalid warehouse checkpoint transition: expected inbound first'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_checkpoint_sequence <> v_previous_checkpoint_sequence + 1 THEN
      RAISE EXCEPTION 'record_scan_event_v1 invalid warehouse checkpoint transition: expected next sequence step'
        USING ERRCODE = '23514';
    END IF;

    v_store_meta := public.jsonb_deep_merge(
      v_store_meta,
      jsonb_build_object(
        'checkpoint_key', v_checkpoint_key,
        'checkpoint_sequence', v_checkpoint_sequence,
        'checkpoint_scope', v_chain_scope
      )
    );
    v_decision_outcome := 'checkpoint_accepted';
  ELSIF v_scan_type = 'correction' THEN
    IF COALESCE((v_correction_policy->>'enabled')::boolean, TRUE) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'record_scan_event_v1 blocked by scan_policy.correction.enabled=false' USING ERRCODE = '42501';
    END IF;

    IF v_correction_of_scan_event_id IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1 requires correction_of_scan_event_id for correction scans' USING ERRCODE = '23514';
    END IF;
    IF v_correction_reason IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1 requires correction_reason for correction scans' USING ERRCODE = '23514';
    END IF;

    SELECT se.scan_type
      INTO v_original_scan_type
      FROM public.scan_events se
     WHERE se.id = v_correction_of_scan_event_id
       AND se.organization_id = v_org
     LIMIT 1;

    IF v_original_scan_type IS NULL THEN
      RAISE EXCEPTION 'record_scan_event_v1 correction_of_scan_event_id not found for org' USING ERRCODE = '23503';
    END IF;
    IF v_original_scan_type = 'correction' THEN
      RAISE EXCEPTION 'record_scan_event_v1 cannot correct a correction scan' USING ERRCODE = '23514';
    END IF;

    IF COALESCE((v_correction_policy->>'require_supervisor_approval')::boolean, TRUE) IS TRUE THEN
      v_approval_task_type_key := COALESCE(NULLIF(btrim(COALESCE(v_correction_policy->>'approval_task_type_key', '')), ''), 'warehouse_scan_supervisor_approval');
      IF v_correction_approval_task_id IS NULL THEN
        RAISE EXCEPTION 'record_scan_event_v1 requires correction_approval_task_id for correction scans' USING ERRCODE = '23514';
      END IF;

      SELECT
        t.id,
        t.status,
        t.resource_type,
        t.resource_id,
        tt.key
      INTO v_approval_task
      FROM public.tasks t
      JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE t.id = v_correction_approval_task_id
        AND t.organization_id = v_org
      LIMIT 1;

      IF v_approval_task.id IS NULL THEN
        RAISE EXCEPTION 'record_scan_event_v1 correction_approval_task_id not found for org' USING ERRCODE = '23503';
      END IF;
      IF lower(COALESCE(v_approval_task.status, '')) <> 'completed' THEN
        RAISE EXCEPTION 'record_scan_event_v1 correction approval task must be completed' USING ERRCODE = '23514';
      END IF;
      IF lower(COALESCE(v_approval_task.key, '')) <> v_approval_task_type_key THEN
        RAISE EXCEPTION 'record_scan_event_v1 correction approval task type mismatch' USING ERRCODE = '23514';
      END IF;
      IF lower(COALESCE(v_approval_task.resource_type, '')) <> 'scan_event' THEN
        RAISE EXCEPTION 'record_scan_event_v1 correction approval task must target scan_event' USING ERRCODE = '23514';
      END IF;
      IF v_approval_task.resource_id IS DISTINCT FROM v_correction_of_scan_event_id THEN
        RAISE EXCEPTION 'record_scan_event_v1 correction approval task must target the original scan event' USING ERRCODE = '23514';
      END IF;
    END IF;

    v_store_meta := public.jsonb_deep_merge(
      v_store_meta,
      jsonb_build_object(
        'correction_of_scan_event_id', v_correction_of_scan_event_id,
        'correction_reason', v_correction_reason,
        'correction_approval_task_id', v_correction_approval_task_id,
        'corrected_scan_type', v_original_scan_type
      )
    );
    v_decision_outcome := 'correction_approved';
  END IF;

  -- Idempotency short-circuit.
  INSERT INTO public.scan_event_dedupe (organization_id, idempotency_key, scan_event_id, created_at)
  VALUES (v_org, v_idempotency, v_id, now())
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT d.scan_event_id INTO v_id
    FROM public.scan_event_dedupe d
    WHERE d.organization_id = v_org AND d.idempotency_key = v_idempotency
    LIMIT 1;
    RETURN QUERY SELECT v_id, FALSE;
    RETURN;
  END IF;

  IF v_scan_type IN ('warehouse_checkpoint', 'correction') THEN
    v_decision_id := public.log_decision(
      p_organization_id := v_org,
      p_decision_category := 'warehouse',
      p_resource_type := 'scan_event',
      p_resource_id := v_id,
      p_decision_point := 'record_scan_event',
      p_decision_outcome := v_decision_outcome,
      p_performed_by_system := 'record_scan_event_v1',
      p_correlation_id := public.current_correlation_id(),
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'scan_type', v_scan_type,
        'barcode', v_barcode,
        'checkpoint_key', v_checkpoint_key,
        'checkpoint_sequence', v_checkpoint_sequence,
        'checkpoint_scope', v_chain_scope,
        'corrects_scan_event_id', v_correction_of_scan_event_id,
        'correction_reason', v_correction_reason,
        'correction_approval_task_id', v_correction_approval_task_id
      )),
      p_decision_reason := NULL,
      p_settings_resolution_id := v_policy_settings_resolution_id
    );

    v_store_meta := public.jsonb_deep_merge(
      v_store_meta,
      jsonb_build_object('decision_log_id', v_decision_id)
    );
  END IF;

  INSERT INTO public.scan_events (
    id, organization_id, actor_user_id, device_id,
    route_run_id, route_stop_id, branch_id,
    ops_session_id,
    client_id, shipment_id,
    handling_unit_id, warehouse_transfer_id,
    artifact_id,
    scan_type, barcode,
    checkpoint_key, checkpoint_sequence,
    correction_of_scan_event_id, correction_reason, correction_approval_task_id,
    coordinates, accuracy_m,
    idempotency_key, metadata,
    captured_at, received_at, created_at
    ) VALUES (
      v_id, v_org, v_user, v_device_id,
      v_run_id, v_stop_id, v_branch_id,
      v_ops_session_id,
      v_client_id, v_shipment_id,
    v_handling_unit_id, v_transfer_id,
    v_artifact_id,
    v_scan_type, v_barcode,
    v_checkpoint_key, v_checkpoint_sequence,
    v_correction_of_scan_event_id, v_correction_reason, v_correction_approval_task_id,
    CASE
      WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography
      ELSE NULL
    END,
    v_accuracy,
    v_idempotency, v_store_meta,
    v_captured_at, now(), now()
  );

  RETURN QUERY SELECT v_id, TRUE;
END;
$function$;

COMMENT ON FUNCTION public.record_scan_event_v1(JSONB)
  IS 'Insert a scan event (SSOT ledger) with idempotency via scan_event_dedupe; policy-resolved; tenant-only; can link scans to handling units, warehouse transfers, and ops sessions. Supports warehouse checkpoint sequencing, append-only corrections, and bulk manifest/container batches.';
REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_scan_event_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_scan_event_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 7) Contracts + retention
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'scan_events', TRUE, FALSE, FALSE, 'Scan events ledger (immutable); audit disabled by contract.'),
  ('public', 'scan_event_dedupe', TRUE, FALSE, FALSE, 'Scan event idempotency keys (service-only).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
)
VALUES (
  'scan_events',
  'HASH+RANGE',
  'organization_id|captured_at',
  'monthly',
  NULL,
  12,
  '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "delete"}'::jsonb
)
ON CONFLICT (table_name) DO UPDATE
SET
  partition_strategy = EXCLUDED.partition_strategy,
  partition_key = EXCLUDED.partition_key,
  partition_interval = EXCLUDED.partition_interval,
  partitions_ahead = EXCLUDED.partitions_ahead,
  retention_months = EXCLUDED.retention_months,
  config = EXCLUDED.config;

-- Bootstrap partitions now (idempotent; uses partitioning_config).
SELECT * FROM public.create_next_partitions();

SELECT pg_advisory_unlock(hashtext('202603191545_scan_events_warehouse_checkpoint_corrections_v1'));
COMMIT;
