-- Migration: B08 UC103/UC105 POD identity confirmation + authorized asset visibility
-- Purpose:
-- - Extend the canonical POD policy contract with identity confirmation requirements.
-- - Capture OTP and recipient identity confirmation at the task_event write path without persisting raw OTP values.
-- - Expose normalized POD identity metadata on shipment_actions UI reads.
-- - Provide browser-safe shipment POD asset listing and download contracts for Console/Portal shipment detail surfaces.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604081130_b08_uc103_uc105_pod_identity_asset_visibility_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) POD policy schema/defaults + tasks.complete schema grow to alternate proof
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'pod_policy',
  3,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'POD Policy v3',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'requirements', jsonb_build_object(
        'type', jsonb_build_array('object', 'null'),
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'completed', jsonb_build_object(
            'type', jsonb_build_array('object', 'null'),
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'photo_required', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
              'signature_required', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
              'otp_required', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
              'identity_confirmation_required', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
              'min_artifact_count', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 0)
            )
          ),
          'exception', jsonb_build_object(
            'type', jsonb_build_array('object', 'null'),
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'exception_reason_required', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
              'notes_required_for_other', jsonb_build_object('type', jsonb_build_array('boolean', 'null')),
              'min_artifact_count', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 0)
            )
          )
        )
      ),
      'binary_evidence', jsonb_build_object(
        'type', jsonb_build_array('object', 'null'),
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'bucket_id', jsonb_build_object('type', jsonb_build_array('string', 'null')),
          'allowed_mime_types', jsonb_build_object(
            'type', jsonb_build_array('array', 'null'),
            'items', jsonb_build_object('type', 'string'),
            'uniqueItems', TRUE
          ),
          'max_file_bytes', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 1),
          'max_items', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 1)
        )
      ),
      'redaction', jsonb_build_object('type', jsonb_build_array('object', 'null'), 'additionalProperties', TRUE),
      'retention_days', jsonb_build_object('type', jsonb_build_array('integer', 'null'), 'minimum', 0)
    )
  ),
  'Proof-of-delivery requirements v3 with alternate proof requirements for OTP and identity confirmation.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 3,
      'enabled', TRUE,
      'requirements', jsonb_build_object(
        'completed', jsonb_build_object(
          'photo_required', TRUE,
          'signature_required', FALSE,
          'otp_required', FALSE,
          'identity_confirmation_required', FALSE,
          'min_artifact_count', 1
        ),
        'exception', jsonb_build_object(
          'exception_reason_required', TRUE,
          'notes_required_for_other', TRUE,
          'min_artifact_count', 0
        )
      ),
      'binary_evidence', jsonb_build_object(
        'bucket_id', 'fieldops-evidence',
        'allowed_mime_types', jsonb_build_array('image/jpeg', 'image/png', 'application/pdf'),
        'max_file_bytes', 5242880,
        'max_items', 6
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

WITH current_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'pod_policy'
),
rewritten AS (
  SELECT
    cr.settings_id,
    cr.settings_version_id,
    cr.version,
    cr.value,
    jsonb_strip_nulls(
      jsonb_set(
        jsonb_set(
          COALESCE(cr.value, '{}'::jsonb),
          '{version}',
          '3'::jsonb,
          TRUE
        ),
        '{requirements,completed}',
        COALESCE(cr.value->'requirements'->'completed', '{}'::jsonb)
          || jsonb_build_object(
            'photo_required', COALESCE((cr.value->'requirements'->'completed'->>'photo_required')::boolean, TRUE),
            'signature_required', COALESCE((cr.value->'requirements'->'completed'->>'signature_required')::boolean, FALSE),
            'otp_required', COALESCE((cr.value->'requirements'->'completed'->>'otp_required')::boolean, FALSE),
            'identity_confirmation_required', COALESCE((cr.value->'requirements'->'completed'->>'identity_confirmation_required')::boolean, FALSE),
            'min_artifact_count', COALESCE((cr.value->'requirements'->'completed'->>'min_artifact_count')::int, 0)
          ),
        TRUE
      )
    ) AS next_value
  FROM current_rows cr
),
changed AS (
  SELECT
    r.settings_id,
    r.settings_version_id,
    r.version,
    r.next_value
  FROM rewritten r
  WHERE r.next_value IS DISTINCT FROM r.value
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = c.next_value,
         schema_version = 3,
         version = COALESCE(c.version, 0) + 1,
         change_reason = 'Extend pod_policy with alternate proof identity requirements',
         approved_at = now(),
         effective_from = now()
    FROM changed c
   WHERE sv.id = c.settings_version_id
  RETURNING sv.id, sv.value, c.settings_id
)
UPDATE public.settings s
   SET cached_value = a.value,
       last_updated = now()
  FROM applied a
 WHERE s.id = a.settings_id;

-------------------------------------------------------------------------------
-- 2) Canonical delivery POD normalization now enforces OTP / identity capture
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_delivery_pod_task_event_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_payload JSONB := COALESCE(NEW.payload, '{}'::jsonb);
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_task_org UUID := NULL;
  v_stop_kind TEXT := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_policy_value JSONB := '{}'::jsonb;
  v_completed_requirements JSONB := '{}'::jsonb;
  v_pod_payload JSONB := '{}'::jsonb;
  v_geostamp JSONB := NULL;
  v_pod_captured_at TIMESTAMPTZ := NULL;
  v_latitude NUMERIC := NULL;
  v_longitude NUMERIC := NULL;
  v_accuracy_m NUMERIC := NULL;
  v_otp_required BOOLEAN := FALSE;
  v_identity_required BOOLEAN := FALSE;
  v_otp_code TEXT := NULL;
  v_otp_last4 TEXT := NULL;
  v_identity_kind TEXT := NULL;
  v_identity_last4 TEXT := NULL;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF lower(COALESCE(NEW.to_status, '')) <> 'completed' THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT
    t.resource_type,
    t.resource_id,
    t.organization_id
    INTO v_resource_type, v_resource_id, v_task_org
  FROM public.tasks t
  WHERE t.id = NEW.task_id
  LIMIT 1;

  IF v_resource_type IS DISTINCT FROM 'route_stop' OR v_resource_id IS NULL OR v_task_org IS NULL THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  SELECT
    lower(rs.stop_kind),
    rs.client_id,
    s.sender_id
    INTO v_stop_kind, v_client_id, v_sender_id
  FROM public.route_stops rs
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.organization_id = rs.organization_id
  WHERE rs.id = v_resource_id
    AND rs.organization_id = v_task_org
  LIMIT 1;

  IF v_stop_kind IS DISTINCT FROM 'delivery' THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  SELECT COALESCE(r.value, '{}'::jsonb)
    INTO v_policy_value
  FROM public.resolve_pod_policy(
    jsonb_strip_nulls(
      jsonb_build_object(
        'organization_id', v_task_org,
        'client_id', v_client_id,
        'sender_id', v_sender_id,
        'resource_type', 'route_stop',
        'resource_id', v_resource_id
      )
    )
  ) AS r
  LIMIT 1;

  v_completed_requirements := COALESCE(v_policy_value->'requirements'->'completed', '{}'::jsonb);

  IF jsonb_typeof(v_payload->'pod') = 'object' THEN
    v_pod_payload := v_payload->'pod';
  END IF;

  BEGIN
    v_pod_captured_at := NULLIF(
      btrim(
        COALESCE(
          v_payload->>'captured_at',
          v_pod_payload->>'captured_at',
          ''
        )
      ),
      ''
    )::timestamptz;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'delivery pod captured_at must be a valid timestamptz'
        USING ERRCODE = '23514';
  END;

  v_pod_captured_at := COALESCE(v_pod_captured_at, NEW.created_at, now());
  v_payload := jsonb_set(v_payload, '{captured_at}', to_jsonb(v_pod_captured_at), TRUE);
  v_payload := jsonb_set(v_payload, '{pod,captured_at}', to_jsonb(v_pod_captured_at), TRUE);

  v_geostamp := CASE
    WHEN jsonb_typeof(v_payload->'geostamp') = 'object' THEN v_payload->'geostamp'
    WHEN jsonb_typeof(v_pod_payload->'geostamp') = 'object' THEN v_pod_payload->'geostamp'
    ELSE NULL
  END;

  IF v_geostamp IS NOT NULL THEN
    BEGIN
      v_latitude := NULLIF(
        btrim(COALESCE(v_geostamp->>'latitude', v_geostamp->>'lat', '')),
        ''
      )::numeric;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'delivery pod geostamp.latitude must be numeric'
          USING ERRCODE = '23514';
    END;

    BEGIN
      v_longitude := NULLIF(
        btrim(COALESCE(v_geostamp->>'longitude', v_geostamp->>'lng', '')),
        ''
      )::numeric;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'delivery pod geostamp.longitude must be numeric'
          USING ERRCODE = '23514';
    END;

    BEGIN
      v_accuracy_m := NULLIF(
        btrim(COALESCE(v_geostamp->>'accuracy_m', '')),
        ''
      )::numeric;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'delivery pod geostamp.accuracy_m must be numeric'
          USING ERRCODE = '23514';
    END;

    IF v_latitude IS NULL OR v_longitude IS NULL THEN
      RAISE EXCEPTION 'delivery pod geostamp requires latitude and longitude'
        USING ERRCODE = '23514';
    END IF;

    IF v_latitude < -90 OR v_latitude > 90 THEN
      RAISE EXCEPTION 'delivery pod geostamp.latitude out of range'
        USING ERRCODE = '23514';
    END IF;

    IF v_longitude < -180 OR v_longitude > 180 THEN
      RAISE EXCEPTION 'delivery pod geostamp.longitude out of range'
        USING ERRCODE = '23514';
    END IF;

    IF v_accuracy_m IS NOT NULL AND v_accuracy_m < 0 THEN
      RAISE EXCEPTION 'delivery pod geostamp.accuracy_m must be non-negative'
        USING ERRCODE = '23514';
    END IF;

    v_geostamp := jsonb_strip_nulls(jsonb_build_object(
      'latitude', v_latitude,
      'longitude', v_longitude,
      'accuracy_m', v_accuracy_m
    ));

    v_payload := jsonb_set(v_payload, '{geostamp}', v_geostamp, TRUE);
    v_payload := jsonb_set(v_payload, '{pod,geostamp}', v_geostamp, TRUE);
  END IF;

  v_otp_required := COALESCE((v_completed_requirements->>'otp_required')::boolean, FALSE);
  v_identity_required := COALESCE((v_completed_requirements->>'identity_confirmation_required')::boolean, FALSE);

  v_otp_code := NULLIF(
    regexp_replace(
      COALESCE(v_payload->>'otp_code', v_pod_payload->>'otp_code', ''),
      '[^0-9]',
      '',
      'g'
    ),
    ''
  );

  IF v_otp_required AND v_otp_code IS NULL THEN
    RAISE EXCEPTION 'delivery pod requires otp_code'
      USING ERRCODE = '23514';
  END IF;

  IF v_otp_code IS NOT NULL THEN
    IF length(v_otp_code) < 4 THEN
      RAISE EXCEPTION 'delivery pod otp_code must contain at least 4 digits'
        USING ERRCODE = '23514';
    END IF;
    v_otp_last4 := right(v_otp_code, 4);
    v_payload := v_payload #- '{otp_code}';
    v_payload := v_payload #- '{pod,otp_code}';
    v_payload := jsonb_set(v_payload, '{otp_confirmed}', 'true'::jsonb, TRUE);
    v_payload := jsonb_set(v_payload, '{otp_last4}', to_jsonb(v_otp_last4), TRUE);
    v_payload := jsonb_set(v_payload, '{pod,otp_confirmed}', 'true'::jsonb, TRUE);
    v_payload := jsonb_set(v_payload, '{pod,otp_last4}', to_jsonb(v_otp_last4), TRUE);
  END IF;

  v_identity_kind := lower(
    NULLIF(
      btrim(
        COALESCE(
          v_payload->>'recipient_identity_kind',
          v_pod_payload->>'recipient_identity_kind',
          ''
        )
      ),
      ''
    )
  );
  v_identity_last4 := upper(
    NULLIF(
      regexp_replace(
        COALESCE(
          v_payload->>'recipient_identity_last4',
          v_pod_payload->>'recipient_identity_last4',
          ''
        ),
        '[^A-Za-z0-9]',
        '',
        'g'
      ),
      ''
    )
  );

  IF v_identity_required AND (v_identity_kind IS NULL OR v_identity_last4 IS NULL) THEN
    RAISE EXCEPTION 'delivery pod requires recipient_identity_kind and recipient_identity_last4'
      USING ERRCODE = '23514';
  END IF;

  IF v_identity_last4 IS NOT NULL THEN
    IF length(v_identity_last4) < 4 THEN
      RAISE EXCEPTION 'delivery pod recipient_identity_last4 must contain at least 4 characters'
        USING ERRCODE = '23514';
    END IF;
    v_identity_last4 := right(v_identity_last4, 4);
  END IF;

  IF v_identity_kind IS NOT NULL THEN
    v_payload := jsonb_set(v_payload, '{recipient_identity_kind}', to_jsonb(v_identity_kind), TRUE);
    v_payload := jsonb_set(v_payload, '{pod,recipient_identity_kind}', to_jsonb(v_identity_kind), TRUE);
  END IF;
  IF v_identity_last4 IS NOT NULL THEN
    v_payload := jsonb_set(v_payload, '{recipient_identity_last4}', to_jsonb(v_identity_last4), TRUE);
    v_payload := jsonb_set(v_payload, '{pod,recipient_identity_last4}', to_jsonb(v_identity_last4), TRUE);
  END IF;

  NEW.payload := v_payload;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.normalize_delivery_pod_task_event_v1()
  IS 'Before-insert task_events guard for delivery completions: normalize POD captured_at/geostamp, sanitize alternate proof fields, and fail closed on missing OTP or identity confirmation requirements.';

-------------------------------------------------------------------------------
-- 3) Canonical route_stop finalize wrapper persists alternate proof metadata
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v8(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_resp public.workflow_handler_response;
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := COALESCE(v_ctx->'payload', '{}'::jsonb);
  v_task_event_payload JSONB := COALESCE(v_payload->'task_event_payload', '{}'::jsonb);
  v_route_stop_id UUID := NULL;
  v_task_event_id UUID := NULL;
  v_shipment_id UUID := NULL;
  v_org UUID := NULL;
  v_client_id UUID := NULL;
  v_shipment_action_id UUID := NULL;
  v_proof_patch JSONB := '{}'::jsonb;
  v_delivery_completion JSONB := '{}'::jsonb;
  v_otp_confirmed BOOLEAN := FALSE;
  v_otp_last4 TEXT := NULL;
  v_identity_kind TEXT := NULL;
  v_identity_last4 TEXT := NULL;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  v_resp := workflow_handlers.execute_route_stop_finalize_v7(p_step, p_run, p_operation_result);
  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  BEGIN
    v_route_stop_id := NULLIF(v_ctx->>'resource_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;

  BEGIN
    v_task_event_id := NULLIF(v_task_event_payload->>'task_event_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_task_event_id := NULL;
  END;

  v_otp_confirmed := COALESCE(
    (v_task_event_payload->>'otp_confirmed')::boolean,
    (v_task_event_payload #>> '{pod,otp_confirmed}')::boolean,
    FALSE
  );
  v_otp_last4 := upper(
    NULLIF(
      regexp_replace(
        COALESCE(
          v_task_event_payload->>'otp_last4',
          v_task_event_payload #>> '{pod,otp_last4}',
          ''
        ),
        '[^A-Za-z0-9]',
        '',
        'g'
      ),
      ''
    )
  );
  IF v_otp_last4 IS NOT NULL THEN
    v_otp_last4 := right(v_otp_last4, 4);
  END IF;

  v_identity_kind := lower(
    NULLIF(
      btrim(
        COALESCE(
          v_task_event_payload->>'recipient_identity_kind',
          v_task_event_payload #>> '{pod,recipient_identity_kind}',
          ''
        )
      ),
      ''
    )
  );
  v_identity_last4 := upper(
    NULLIF(
      regexp_replace(
        COALESCE(
          v_task_event_payload->>'recipient_identity_last4',
          v_task_event_payload #>> '{pod,recipient_identity_last4}',
          ''
        ),
        '[^A-Za-z0-9]',
        '',
        'g'
      ),
      ''
    )
  );
  IF v_identity_last4 IS NOT NULL THEN
    v_identity_last4 := right(v_identity_last4, 4);
  END IF;

  v_proof_patch := jsonb_strip_nulls(jsonb_build_object(
    'otp_confirmed', CASE WHEN v_otp_confirmed THEN TRUE ELSE NULL END,
    'otp_last4', v_otp_last4,
    'recipient_identity_kind', v_identity_kind,
    'recipient_identity_last4', v_identity_last4
  ));

  IF v_proof_patch = '{}'::jsonb OR v_route_stop_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT
    rs.shipment_id,
    rs.organization_id,
    rs.client_id
    INTO v_shipment_id, v_org, v_client_id
  FROM public.route_stops rs
  WHERE rs.id = v_route_stop_id
  LIMIT 1;

  IF v_shipment_id IS NULL OR v_org IS NULL OR v_client_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT sa.id
    INTO v_shipment_action_id
  FROM public.shipment_actions sa
  WHERE sa.shipment_id = v_shipment_id
    AND sa.organization_id = v_org
    AND sa.client_id = v_client_id
    AND (
      (v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text)
      OR (sa.action_data->>'route_stop_id') = v_route_stop_id::text
    )
  ORDER BY
    CASE
      WHEN v_task_event_id IS NOT NULL AND (sa.action_data->>'task_event_id') = v_task_event_id::text THEN 0
      ELSE 1
    END,
    sa.timestamp DESC,
    sa.created_at DESC
  LIMIT 1;

  IF v_shipment_action_id IS NOT NULL THEN
    UPDATE public.shipment_actions sa
       SET action_data = jsonb_set(
             COALESCE(sa.action_data, '{}'::jsonb),
             '{delivery_completion}',
             COALESCE(sa.action_data->'delivery_completion', '{}'::jsonb) || v_proof_patch,
             TRUE
           )
     WHERE sa.id = v_shipment_action_id;
  END IF;

  UPDATE public.shipments s
     SET metadata = jsonb_set(
           COALESCE(s.metadata, '{}'::jsonb),
           '{delivery_completion}',
           COALESCE(s.metadata->'delivery_completion', '{}'::jsonb) || v_proof_patch,
           TRUE
         ),
         updated_at = now()
   WHERE s.id = v_shipment_id
     AND s.client_id = v_client_id;

  UPDATE public.route_stops rs
     SET metadata = jsonb_set(
           COALESCE(rs.metadata, '{}'::jsonb),
           '{delivery_completion}',
           COALESCE(rs.metadata->'delivery_completion', '{}'::jsonb) || v_proof_patch,
           TRUE
         ),
         updated_at = now()
   WHERE rs.id = v_route_stop_id;

  v_delivery_completion := COALESCE(v_resp.operation_result->'delivery_completion', '{}'::jsonb) || v_proof_patch;
  v_resp.operation_result := jsonb_set(
    COALESCE(v_resp.operation_result, '{}'::jsonb),
    '{delivery_completion}',
    v_delivery_completion,
    TRUE
  );

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v8',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v8',
  TRUE,
  'Finalize a dispatch route_stop execution through v7 while persisting delivery closeout alternate proof metadata for OTP confirmation and recipient identity proof.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_stop_finalize_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
     SET handler_version = 'v8',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

-------------------------------------------------------------------------------
-- 4) Shipment action proof projections + POD asset read/download contracts
-------------------------------------------------------------------------------

ALTER TABLE public.shipment_actions
  ADD COLUMN IF NOT EXISTS pod_otp_confirmed BOOLEAN
    GENERATED ALWAYS AS (
      COALESCE(
        (action_data #>> ARRAY['delivery_completion', 'otp_confirmed'])::boolean,
        (action_data #>> ARRAY['task_event_payload', 'pod', 'otp_confirmed'])::boolean,
        (action_data #>> ARRAY['task_event_payload', 'otp_confirmed'])::boolean,
        FALSE
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS pod_otp_last4 TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'otp_last4'],
            action_data #>> ARRAY['task_event_payload', 'pod', 'otp_last4'],
            action_data #>> ARRAY['task_event_payload', 'otp_last4'],
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS pod_identity_kind TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'recipient_identity_kind'],
            action_data #>> ARRAY['task_event_payload', 'pod', 'recipient_identity_kind'],
            action_data #>> ARRAY['task_event_payload', 'recipient_identity_kind'],
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS pod_identity_last4 TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'recipient_identity_last4'],
            action_data #>> ARRAY['task_event_payload', 'pod', 'recipient_identity_last4'],
            action_data #>> ARRAY['task_event_payload', 'recipient_identity_last4'],
            ''
          )
        ),
        ''
      )
    ) STORED;

COMMENT ON COLUMN public.shipment_actions.pod_otp_confirmed IS
  'Generated UI-read projection for whether delivery OTP confirmation succeeded.';
COMMENT ON COLUMN public.shipment_actions.pod_otp_last4 IS
  'Generated UI-read projection of the last four OTP digits persisted for delivery confirmation.';
COMMENT ON COLUMN public.shipment_actions.pod_identity_kind IS
  'Generated UI-read projection of the normalized recipient identity confirmation type.';
COMMENT ON COLUMN public.shipment_actions.pod_identity_last4 IS
  'Generated UI-read projection of the last four recipient identity characters captured during delivery confirmation.';

CREATE OR REPLACE FUNCTION public.ui_list_shipment_pod_assets_v1(
  p_shipment_id UUID
)
RETURNS TABLE (
  shipment_id UUID,
  shipment_action_id UUID,
  artifact_id UUID,
  asset_kind TEXT,
  label TEXT,
  file_name TEXT,
  mime_type TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_shipment JSONB := NULL;
BEGIN
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'ui_list_shipment_pod_assets_v1 requires shipment_id';
  END IF;

  v_shipment := public.ui_get_resource_v1('shipments', p_shipment_id);
  IF v_shipment IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH pod_actions AS (
    SELECT
      sa.id,
      sa.timestamp,
      sa.created_at,
      COALESCE(
        sa.action_data #>> ARRAY['delivery_completion', 'signature_artifact_id'],
        sa.action_data #>> ARRAY['task_event_payload', 'pod', 'signature_artifact_id'],
        sa.action_data #>> ARRAY['task_event_payload', 'signature_artifact_id'],
        sa.action_data #>> ARRAY['pod', 'signature_artifact_id'],
        sa.action_data ->> 'signature_artifact_id'
      ) AS signature_artifact_id
    FROM public.shipment_actions sa
    WHERE sa.shipment_id = p_shipment_id
      AND sa.organization_id = public.current_user_org_id()
      AND (
        sa.delivery_completion_kind IS NOT NULL
        OR sa.handover_mode IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM public.artifact_links al
          WHERE al.organization_id = sa.organization_id
            AND al.resource_type = 'shipment_action'
            AND al.resource_id = sa.id
            AND al.relation_type = 'pod'
        )
      )
  ),
  asset_rows AS (
    SELECT DISTINCT ON (al.artifact_id)
      p_shipment_id AS shipment_id,
      pa.id AS shipment_action_id,
      al.artifact_id,
      CASE
        WHEN al.artifact_id::text = pa.signature_artifact_id THEN 'signature'
        WHEN COALESCE(a.mime_type, '') ILIKE 'image/%' THEN 'photo'
        ELSE 'file'
      END AS asset_kind,
      CASE
        WHEN al.artifact_id::text = pa.signature_artifact_id THEN 'Recipient signature'
        WHEN COALESCE(a.mime_type, '') ILIKE 'image/%' THEN 'Proof photo'
        ELSE 'Proof attachment'
      END AS label,
      COALESCE(
        NULLIF(btrim(COALESCE(a.metadata->>'file_name', '')), ''),
        NULLIF(btrim(COALESCE(a.metadata->>'original_file_name', '')), ''),
        regexp_replace(a.storage_key, '^.*/', '')
      ) AS file_name,
      a.mime_type,
      al.created_at
    FROM pod_actions pa
    JOIN public.artifact_links al
      ON al.organization_id = public.current_user_org_id()
     AND al.resource_type = 'shipment_action'
     AND al.resource_id = pa.id
     AND al.relation_type = 'pod'
    JOIN public.artifacts a
      ON a.id = al.artifact_id
     AND a.organization_id = al.organization_id
    ORDER BY al.artifact_id, pa.timestamp DESC, pa.created_at DESC, al.created_at DESC
  )
  SELECT
    asset_rows.shipment_id,
    asset_rows.shipment_action_id,
    asset_rows.artifact_id,
    asset_rows.asset_kind,
    asset_rows.label,
    asset_rows.file_name,
    asset_rows.mime_type,
    asset_rows.created_at
  FROM asset_rows
  ORDER BY
    CASE asset_rows.asset_kind
      WHEN 'signature' THEN 0
      WHEN 'photo' THEN 1
      ELSE 2
    END,
    asset_rows.created_at DESC,
    asset_rows.artifact_id;
END;
$function$;

COMMENT ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID)
  IS 'List proof-of-delivery artifacts for a caller-visible shipment via canonical shipment_action artifact_links.';

REVOKE ALL ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_list_shipment_pod_assets_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_get_shipment_pod_asset_download_v1(
  p_shipment_id UUID,
  p_artifact_id UUID
)
RETURNS TABLE (
  storage_bucket TEXT,
  storage_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  asset_kind TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
BEGIN
  IF p_shipment_id IS NULL OR p_artifact_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_shipment_pod_asset_download_v1 requires shipment_id and artifact_id';
  END IF;

  RETURN QUERY
  SELECT
    a.storage_bucket,
    a.storage_key,
    assets.file_name,
    assets.mime_type,
    assets.asset_kind
  FROM public.ui_list_shipment_pod_assets_v1(p_shipment_id) AS assets
  JOIN public.artifacts a
    ON a.id = assets.artifact_id
   AND a.organization_id = public.current_user_org_id()
  WHERE assets.artifact_id = p_artifact_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_get_shipment_pod_asset_download_v1 artifact % is not available for shipment %', p_artifact_id, p_shipment_id
      USING ERRCODE = 'P0002';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID)
  IS 'Resolve the canonical storage bucket/key for a caller-visible proof-of-delivery artifact linked to a shipment.';

REVOKE ALL ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_get_shipment_pod_asset_download_v1(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_list_shipment_pod_assets_v1(
  p_shipment_id UUID
)
RETURNS TABLE (
  shipment_id UUID,
  shipment_action_id UUID,
  artifact_id UUID,
  asset_kind TEXT,
  label TEXT,
  file_name TEXT,
  mime_type TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_list_shipment_pod_assets_v1(p_shipment_id);
$fn$;

REVOKE ALL ON FUNCTION api.ui_list_shipment_pod_assets_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_list_shipment_pod_assets_v1(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_get_shipment_pod_asset_download_v1(
  p_shipment_id UUID,
  p_artifact_id UUID
)
RETURNS TABLE (
  storage_bucket TEXT,
  storage_key TEXT,
  file_name TEXT,
  mime_type TEXT,
  asset_kind TEXT
)
LANGUAGE sql
STABLE
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT * FROM public.ui_get_shipment_pod_asset_download_v1(p_shipment_id, p_artifact_id);
$fn$;

REVOKE ALL ON FUNCTION api.ui_get_shipment_pod_asset_download_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_get_shipment_pod_asset_download_v1(UUID, UUID) TO authenticated, service_role;

DO $do$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_select JSONB := '[]'::jsonb;
  v_columns JSONB := '[]'::jsonb;
  v_existing_column JSONB;
  v_new_column JSONB;
  v_column_def JSONB;
  v_new_select_key TEXT;
  v_found BOOLEAN := FALSE;
  v_column_defs JSONB := jsonb_build_array(
    jsonb_build_object('key', 'pod_otp_confirmed', 'label', 'OTP confirmed', 'detail_section', 'Proof of delivery'),
    jsonb_build_object('key', 'pod_otp_last4', 'label', 'OTP last 4', 'detail_section', 'Proof of delivery'),
    jsonb_build_object('key', 'pod_identity_kind', 'label', 'Identity type', 'detail_section', 'Proof of delivery'),
    jsonb_build_object('key', 'pod_identity_last4', 'label', 'Identity last 4', 'detail_section', 'Proof of delivery')
  );
  v_next_columns JSONB := '[]'::jsonb;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    v_resources := '[]'::jsonb;
  END IF;

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'shipment_actions' THEN
      v_found := TRUE;

      v_select := COALESCE(v_resource->'select', '[]'::jsonb);
      IF jsonb_typeof(v_select) IS DISTINCT FROM 'array' THEN
        v_select := '[]'::jsonb;
      END IF;

      FOREACH v_new_select_key IN ARRAY ARRAY[
        'pod_otp_confirmed',
        'pod_otp_last4',
        'pod_identity_kind',
        'pod_identity_last4'
      ] LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(v_select) AS item(value)
          WHERE item.value = v_new_select_key
        ) THEN
          v_select := v_select || to_jsonb(v_new_select_key);
        END IF;
      END LOOP;
      v_resource := jsonb_set(v_resource, '{select}', v_select, TRUE);

      v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
      IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' THEN
        v_columns := '[]'::jsonb;
      END IF;

      v_next_columns := '[]'::jsonb;
      FOR v_existing_column IN SELECT * FROM jsonb_array_elements(v_columns) LOOP
        v_new_column := v_existing_column;
        FOR v_column_def IN SELECT * FROM jsonb_array_elements(v_column_defs) LOOP
          IF v_new_column->>'key' = v_column_def->>'key' THEN
            v_new_column := jsonb_strip_nulls(v_new_column || v_column_def);
          END IF;
        END LOOP;
        v_next_columns := v_next_columns || jsonb_build_array(v_new_column);
      END LOOP;

      FOR v_new_column IN SELECT * FROM jsonb_array_elements(v_column_defs) LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_next_columns) AS existing(item)
          WHERE existing.item->>'key' = v_new_column->>'key'
        ) THEN
          v_next_columns := v_next_columns || jsonb_build_array(v_new_column);
        END IF;
      END LOOP;

      v_resource := jsonb_set(v_resource, '{columns}', v_next_columns, TRUE);
      v_resource := jsonb_set(
        v_resource,
        '{column_labels}',
        COALESCE(v_resource->'column_labels', '{}'::jsonb) || jsonb_build_object(
          'pod_otp_confirmed', 'OTP confirmed',
          'pod_otp_last4', 'OTP last 4',
          'pod_identity_kind', 'Identity type',
          'pod_identity_last4', 'Identity last 4'
        ),
        TRUE
      );
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  IF v_found IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_read_registry missing shipment_actions resource';
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Expose alternate proof metadata on shipment_actions UI reads',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END;
$do$;
-------------------------------------------------------------------------------
-- 5) Grow tasks.complete browser schema to collect alternate proof inputs
-------------------------------------------------------------------------------

WITH target_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_command_registry'
),
rewritten AS (
  SELECT
    tr.settings_id,
    tr.settings_version_id,
    tr.version,
    tr.value,
    jsonb_set(
      tr.value,
      '{commands}',
      COALESCE(
        (
          SELECT jsonb_agg(
            CASE
              WHEN item->>'key' = 'tasks.complete' THEN
                jsonb_set(
                  item,
                  '{execution,input_schema}',
                  jsonb_build_object(
                    'version', 'v5',
                    'title', 'Complete stop',
                    'description', 'Capture handover mode, recipient confirmation, alternate proof, and partial-delivery details. Proof photos are collected by the mobile shell.',
                    'fields', jsonb_build_array(
                      jsonb_build_object(
                        'key', 'completion_kind',
                        'label', 'Completion kind',
                        'type', 'lookup',
                        'lookup_category', 'delivery_completion_kind',
                        'required', FALSE,
                        'default_value', 'full'
                      ),
                      jsonb_build_object(
                        'key', 'delivered_box_numbers',
                        'label', 'Delivered box numbers',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'For partial delivery only: enter delivered box numbers like 1,2'
                      ),
                      jsonb_build_object(
                        'key', 'handover_mode',
                        'label', 'Handover mode',
                        'type', 'lookup',
                        'lookup_category', 'delivery_handover_mode',
                        'required', FALSE,
                        'default_value', 'named_recipient'
                      ),
                      jsonb_build_object(
                        'key', 'recipient_name',
                        'label', 'Recipient name',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'Who received the shipment?'
                      ),
                      jsonb_build_object(
                        'key', 'recipient_class',
                        'label', 'Recipient class',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'Concierge, front desk, mailroom, or similar.'
                      ),
                      jsonb_build_object(
                        'key', 'otp_code',
                        'label', 'Recipient OTP',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'Enter the handover OTP when required.'
                      ),
                      jsonb_build_object(
                        'key', 'recipient_identity_kind',
                        'label', 'Identity type',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'National ID, passport, locker PIN, or similar.'
                      ),
                      jsonb_build_object(
                        'key', 'recipient_identity_last4',
                        'label', 'Identity last 4',
                        'type', 'text',
                        'required', FALSE,
                        'placeholder', 'Last 4 digits or characters of the confirmed identity.'
                      ),
                      jsonb_build_object(
                        'key', 'completion_notes',
                        'label', 'Completion notes',
                        'type', 'textarea',
                        'required', FALSE,
                        'placeholder', 'Add handoff notes, locker details, or drop-off context.'
                      )
                    )
                  ),
                  TRUE
                )
              ELSE item
            END
          )
          FROM jsonb_array_elements(COALESCE(tr.value->'commands', '[]'::jsonb)) AS item
        ),
        '[]'::jsonb
      ),
      TRUE
    ) AS next_value
  FROM target_rows tr
),
changed AS (
  SELECT
    r.settings_id,
    r.settings_version_id,
    r.version,
    r.next_value
  FROM rewritten r
  WHERE r.next_value IS DISTINCT FROM r.value
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = c.next_value,
         version = COALESCE(c.version, 0) + 1,
         change_reason = 'Expose OTP and identity confirmation inputs on tasks.complete schema',
         approved_at = now(),
         effective_from = now()
    FROM changed c
   WHERE sv.id = c.settings_version_id
  RETURNING sv.id, sv.value, c.settings_id
)
UPDATE public.settings s
   SET cached_value = a.value,
       last_updated = now()
  FROM applied a
 WHERE s.id = a.settings_id;

SELECT pg_advisory_unlock(hashtext('202604081130_b08_uc103_uc105_pod_identity_asset_visibility_v1'));
COMMIT;
