-- Migration: compose_label_payload adds label_print_profile + settings provenance logging
-- Purpose:
--  - Resolve and embed label_print_profile into the payload (row-driven via settings ladder).
--  - Log settings resolution provenance (settings_resolution_log) for:
--      - label_render_policy
--      - label_print_profile
--  - Return lightweight resolution pointers in the payload for downstream renderers.

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE FUNCTION compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_job label_jobs%ROWTYPE;
  v_sender_id UUID;
  v_scope_type TEXT;
  v_scope_id UUID;

  v_policy_row RECORD;
  v_policy JSONB;
  v_policy_resolution_id UUID := NULL;

  v_print_row RECORD;
  v_print_profile JSONB;
  v_print_resolution_id UUID := NULL;

  v_payload JSONB;
  v_shipment_metadata JSONB;
  v_explicit_header_mode TEXT;
  v_effective_header_mode TEXT;
BEGIN
  SELECT *
    INTO v_job
    FROM label_jobs
   WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label job % not found', p_job_id;
  END IF;

  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  SELECT sender_id
    INTO v_sender_id
    FROM shipments
   WHERE id = v_job.shipment_id;

  -- Resolve starting scope for ladder (prefer most specific known).
  IF v_sender_id IS NOT NULL THEN
    v_scope_type := 'sender';
    v_scope_id := v_sender_id;
  ELSIF v_job.client_id IS NOT NULL THEN
    v_scope_type := 'client';
    v_scope_id := v_job.client_id;
  ELSIF v_job.organization_id IS NOT NULL THEN
    v_scope_type := 'tenant';
    v_scope_id := v_job.organization_id;
  ELSE
    v_scope_type := 'global';
    v_scope_id := NULL;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Resolve label_render_policy (winning row) + provenance log
  -- ---------------------------------------------------------------------------
  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row('label_render_policy', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    -- Final fallback: enforce global presence explicitly
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row('label_render_policy', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'label_render_policy missing (global) - seed defaults before rendering';
  END IF;

  v_policy := v_policy_row.value;

  v_policy_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_render_policy',
    p_winning_scope_type := v_policy_row.scope_type,
    p_winning_scope_id := v_policy_row.scope_id,
    p_winning_settings_id := v_policy_row.settings_id,
    p_winning_settings_version_id := v_policy_row.settings_version_id,
    p_winning_version := v_policy_row.version,
    p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'label_job_id', v_job.id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'client_id', v_job.client_id,
      'sender_id', v_sender_id,
      'label_type', v_job.label_type
    )),
    p_merge_notes := NULL
  );

  -- ---------------------------------------------------------------------------
  -- Resolve label_print_profile (winning row) + provenance log
  -- ---------------------------------------------------------------------------
  SELECT *
    INTO v_print_row
    FROM public.resolve_settings_row('label_print_profile', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    SELECT *
      INTO v_print_row
      FROM public.resolve_settings_row('label_print_profile', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    RAISE EXCEPTION 'label_print_profile missing (global) - seed defaults before rendering';
  END IF;

  v_print_profile := v_print_row.value;

  v_print_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_print_profile',
    p_winning_scope_type := v_print_row.scope_type,
    p_winning_scope_id := v_print_row.scope_id,
    p_winning_settings_id := v_print_row.settings_id,
    p_winning_settings_version_id := v_print_row.settings_version_id,
    p_winning_version := v_print_row.version,
    p_scope_path := COALESCE(v_print_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'label_job_id', v_job.id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'client_id', v_job.client_id,
      'sender_id', v_sender_id,
      'label_type', v_job.label_type
    )),
    p_merge_notes := NULL
  );

  -- ---------------------------------------------------------------------------
  -- Base shipment payload
  -- ---------------------------------------------------------------------------
  SELECT to_jsonb(payload)
    INTO v_payload
    FROM shipment_label_payload_v payload
   WHERE payload.shipment_id = v_job.shipment_id
     AND (
       v_job.shipment_box_id IS NULL
       OR payload.shipment_box_id = v_job.shipment_box_id
     )
   ORDER BY payload.box_number NULLS FIRST
   LIMIT 1;

  v_payload := COALESCE(v_payload, '{}'::jsonb);

  -- Persist resolved settings for renderers/tests (no hardcoding downstream).
  v_payload := jsonb_set(v_payload, '{label_render_policy}', v_policy, TRUE);
  v_payload := jsonb_set(v_payload, '{label_print_profile}', v_print_profile, TRUE);

  v_payload := jsonb_set(
    v_payload,
    '{label_render_policy_resolution}',
    jsonb_strip_nulls(jsonb_build_object(
      'settings_resolution_id', v_policy_resolution_id,
      'winning_scope_type', v_policy_row.scope_type,
      'winning_scope_id', v_policy_row.scope_id,
      'version', v_policy_row.version
    )),
    TRUE
  );

  v_payload := jsonb_set(
    v_payload,
    '{label_print_profile_resolution}',
    jsonb_strip_nulls(jsonb_build_object(
      'settings_resolution_id', v_print_resolution_id,
      'winning_scope_type', v_print_row.scope_type,
      'winning_scope_id', v_print_row.scope_id,
      'version', v_print_row.version
    )),
    TRUE
  );

  -- Header brand mode defaulting (shipment metadata > policy).
  v_shipment_metadata := v_payload->'shipment_metadata';
  IF v_shipment_metadata IS NULL OR jsonb_typeof(v_shipment_metadata) <> 'object' THEN
    v_shipment_metadata := '{}'::jsonb;
  END IF;

  v_explicit_header_mode := NULLIF(trim(COALESCE(
    v_shipment_metadata->>'header_brand_mode',
    v_shipment_metadata->>'headerBrandMode'
  )), '');

  v_effective_header_mode := v_explicit_header_mode;
  IF v_effective_header_mode IS NULL THEN
    v_effective_header_mode := NULLIF(trim(v_policy->>'header_brand_mode'), '');
  END IF;

  IF v_effective_header_mode IS NULL THEN
    RAISE EXCEPTION 'label_render_policy.header_brand_mode missing (global) - seed defaults before rendering';
  END IF;

  -- Canonicalize key into shipment_metadata for template render_if paths.
  v_shipment_metadata := jsonb_set(v_shipment_metadata, '{header_brand_mode}', to_jsonb(v_effective_header_mode), TRUE);
  v_payload := jsonb_set(v_payload, '{shipment_metadata}', v_shipment_metadata, TRUE);

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'organization_id', v_job.organization_id,
      'client_id', v_job.client_id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'label_type', v_job.label_type,
      'attempts', v_job.attempts,
      'max_attempts', v_job.max_attempts,
      'template', v_job.template_snapshot,
      'renderer_hint', v_job.renderer_hint,
      'retry_state', v_job.retry_state
    ),
    'payload', v_payload
  );
END;
$$;

COMMENT ON FUNCTION compose_label_payload(UUID)
  IS 'Return canonical payload + template snapshot for a label job (includes resolved label_render_policy + label_print_profile + provenance ids).';

COMMIT;

