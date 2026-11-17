-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S04
-- Migration: Public tracking customer shipment change review, diff, and notification flow v1
-- Date: 2026-03-09

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091130_public_tracking_customer_change_review_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Projection helpers on support_cases for dedicated shipment-change review
-------------------------------------------------------------------------------

ALTER TABLE public.support_cases
  ADD COLUMN IF NOT EXISTS request_outcome TEXT
    GENERATED ALWAYS AS (NULLIF(btrim(metadata->>'request_outcome'), '')) STORED,
  ADD COLUMN IF NOT EXISTS requester_channel TEXT
    GENERATED ALWAYS AS (NULLIF(btrim(metadata->>'requester_channel'), '')) STORED,
  ADD COLUMN IF NOT EXISTS tracking_number TEXT
    GENERATED ALWAYS AS (NULLIF(btrim(metadata->>'tracking_number'), '')) STORED,
  ADD COLUMN IF NOT EXISTS shipment_status_snapshot TEXT
    GENERATED ALWAYS AS (NULLIF(btrim(metadata #>> ARRAY['current_snapshot','shipment_status']), '')) STORED,
  ADD COLUMN IF NOT EXISTS change_summary TEXT
    GENERATED ALWAYS AS (NULLIF(btrim(metadata->>'change_summary'), '')) STORED,
  ADD COLUMN IF NOT EXISTS changed_fields JSONB
    GENERATED ALWAYS AS (COALESCE(metadata->'changed_fields', '[]'::jsonb)) STORED;

CREATE INDEX IF NOT EXISTS idx_support_cases_request_outcome
  ON public.support_cases (organization_id, request_source, request_outcome, created_at DESC)
  WHERE request_source IS NOT NULL AND request_outcome IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_cases_tracking_number
  ON public.support_cases (organization_id, tracking_number, created_at DESC)
  WHERE tracking_number IS NOT NULL;

COMMENT ON COLUMN public.support_cases.request_outcome IS
  'Derived customer shipment change outcome from metadata.request_outcome (applied, pending_review, rejected).';
COMMENT ON COLUMN public.support_cases.requester_channel IS
  'Derived requester channel for customer shipment change requests.';
COMMENT ON COLUMN public.support_cases.tracking_number IS
  'Derived shipment tracking number snapshot for customer shipment change requests.';
COMMENT ON COLUMN public.support_cases.shipment_status_snapshot IS
  'Derived shipment status from metadata.current_snapshot for customer shipment change review lists.';
COMMENT ON COLUMN public.support_cases.change_summary IS
  'Derived human summary from metadata.change_summary for customer shipment change lists.';
COMMENT ON COLUMN public.support_cases.changed_fields IS
  'Derived changed field list from metadata.changed_fields for customer shipment change review.';

-------------------------------------------------------------------------------
-- 2) Extend public_tracking_policy schema + global defaults
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active,
  created_at
)
VALUES (
  'public_tracking_policy',
  1,
  '{
    "type":"object",
    "additionalProperties":false,
    "required":["version","enabled","lookup","session","rate_limit","masking","timeline","actions","notifications"],
    "properties":{
      "version":{"type":"integer","const":1},
      "enabled":{"type":"boolean"},
      "lookup":{
        "type":"object",
        "additionalProperties":false,
        "required":["min_reference_length","max_reference_length","verification_phone_digits","allowed_reference_types"],
        "properties":{
          "min_reference_length":{"type":"integer","minimum":1,"maximum":128},
          "max_reference_length":{"type":"integer","minimum":1,"maximum":256},
          "verification_phone_digits":{"type":"integer","minimum":3,"maximum":6},
          "allowed_reference_types":{"type":"array","items":{"type":"string"},"minItems":1}
        }
      },
      "session":{
        "type":"object",
        "additionalProperties":false,
        "required":["ttl_seconds"],
        "properties":{"ttl_seconds":{"type":"integer","minimum":60,"maximum":86400}}
      },
      "rate_limit":{
        "type":"object",
        "additionalProperties":false,
        "required":["lookup","verify","session","request"],
        "properties":{
          "lookup":{"$ref":"#/definitions/rate_limit"},
          "verify":{"$ref":"#/definitions/rate_limit"},
          "session":{"$ref":"#/definitions/rate_limit"},
          "request":{"$ref":"#/definitions/rate_limit"}
        }
      },
      "masking":{
        "type":"object",
        "additionalProperties":false,
        "required":["phone_keep_last","email_keep_prefix","name_keep_prefix","short_national_address_keep_last"],
        "properties":{
          "phone_keep_last":{"type":"integer","minimum":1,"maximum":6},
          "email_keep_prefix":{"type":"integer","minimum":1,"maximum":8},
          "name_keep_prefix":{"type":"integer","minimum":1,"maximum":8},
          "short_national_address_keep_last":{"type":"integer","minimum":1,"maximum":8}
        }
      },
      "timeline":{
        "type":"object",
        "additionalProperties":false,
        "required":["max_items","allowed_action_types"],
        "properties":{
          "max_items":{"type":"integer","minimum":1,"maximum":50},
          "allowed_action_types":{"type":"array","items":{"type":"string"},"minItems":1}
        }
      },
      "actions":{
        "type":"object",
        "additionalProperties":false,
        "required":["reschedule","location_change"],
        "properties":{
          "reschedule":{"$ref":"#/definitions/request_action"},
          "location_change":{"$ref":"#/definitions/request_action"}
        }
      },
      "notifications":{
        "type":"object",
        "additionalProperties":false,
        "required":["reviewer_in_app","reviewer_email","requester_received","requester_applied","requester_rejected","task"],
        "properties":{
          "reviewer_in_app":{"type":"boolean"},
          "reviewer_email":{"type":"boolean"},
          "requester_received":{"type":"boolean"},
          "requester_applied":{"type":"boolean"},
          "requester_rejected":{"type":"boolean"},
          "task":{
            "type":"object",
            "additionalProperties":false,
            "required":["organization_slug","task_type_key","priority","sla_minutes"],
            "properties":{
              "organization_slug":{"type":"string","minLength":1},
              "task_type_key":{"type":"string","minLength":1},
              "queue_key":{"type":"string"},
              "priority":{"type":"integer","minimum":0,"maximum":1000},
              "sla_minutes":{"type":"integer","minimum":1,"maximum":10080}
            }
          }
        }
      }
    },
    "definitions":{
      "rate_limit":{
        "type":"object",
        "additionalProperties":false,
        "required":["window_seconds","max_requests"],
        "properties":{
          "window_seconds":{"type":"integer","minimum":1,"maximum":86400},
          "max_requests":{"type":"integer","minimum":1,"maximum":100000}
        }
      },
      "request_action":{
        "type":"object",
        "additionalProperties":false,
        "required":["enabled","priority","sla_minutes","execution_mode"],
        "properties":{
          "enabled":{"type":"boolean"},
          "priority":{"type":"string"},
          "sla_minutes":{"type":"integer","minimum":1,"maximum":10080},
          "horizon_days":{"type":"integer","minimum":1,"maximum":60},
          "execution_mode":{"type":"string","enum":["review_required","auto_apply","auto_apply_with_fallback_to_review"]},
          "apply_scope":{"type":"string"}
        }
      }
    }
  }'::jsonb,
  'Public landing tracking policy schema (v1) with shipment change execution and notification controls.',
  '[
    {
      "version":1,
      "enabled":true,
      "lookup":{
        "min_reference_length":6,
        "max_reference_length":64,
        "verification_phone_digits":3,
        "allowed_reference_types":["tracking_number","client_reference_number","carrier_reference_number"]
      },
      "session":{"ttl_seconds":1800},
      "rate_limit":{
        "lookup":{"window_seconds":300,"max_requests":20},
        "verify":{"window_seconds":300,"max_requests":10},
        "session":{"window_seconds":300,"max_requests":30},
        "request":{"window_seconds":1800,"max_requests":10}
      },
      "masking":{
        "phone_keep_last":3,
        "email_keep_prefix":1,
        "name_keep_prefix":1,
        "short_national_address_keep_last":4
      },
      "timeline":{
        "max_items":12,
        "allowed_action_types":["status_change","location_update","exception","delay","scan","promise_assigned","delivery_slot_reserved"]
      },
      "actions":{
        "reschedule":{"enabled":true,"priority":"medium","sla_minutes":120,"horizon_days":7,"execution_mode":"auto_apply_with_fallback_to_review"},
        "location_change":{"enabled":true,"priority":"high","sla_minutes":60,"execution_mode":"auto_apply_with_fallback_to_review","apply_scope":"any_valid_address"}
      },
      "notifications":{
        "reviewer_in_app":true,
        "reviewer_email":false,
        "requester_received":true,
        "requester_applied":true,
        "requester_rejected":true,
        "task":{"organization_slug":"global-root","task_type_key":"customer_shipment_change_review","queue_key":"public_tracking","priority":40,"sla_minutes":60}
      }
    }
  ]'::jsonb,
  TRUE,
  workflow_now()
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH global_row AS (
  SELECT s.id AS settings_id,
         sv.id AS settings_version_id,
         sv.value AS current_value,
         sv.version AS current_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'public_tracking_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
merged AS (
  SELECT
    settings_id,
    settings_version_id,
    public.deep_merge_jsonb(
      current_value,
      jsonb_build_object(
        'actions', jsonb_build_object(
          'reschedule', jsonb_build_object('execution_mode', 'auto_apply_with_fallback_to_review'),
          'location_change', jsonb_build_object('execution_mode', 'auto_apply_with_fallback_to_review', 'apply_scope', 'any_valid_address')
        ),
        'notifications', jsonb_build_object(
          'reviewer_in_app', TRUE,
          'reviewer_email', FALSE,
          'requester_received', TRUE,
          'requester_applied', TRUE,
          'requester_rejected', TRUE,
          'task', jsonb_build_object(
            'organization_slug', 'global-root',
            'task_type_key', 'customer_shipment_change_review',
            'queue_key', 'public_tracking',
            'priority', 40,
            'sla_minutes', 60
          )
        )
      )
    ) AS next_value,
    current_version
  FROM global_row
),
applied AS (
  UPDATE public.settings_versions sv
  SET value = merged.next_value,
      version = merged.current_version + 1,
      change_reason = 'Extend public_tracking_policy defaults with execution and notification controls for customer shipment changes.',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  FROM merged
  WHERE sv.id = merged.settings_version_id
    AND merged.next_value IS DISTINCT FROM sv.value
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = applied.value,
    last_updated = workflow_now()
FROM applied
WHERE s.category = 'public_tracking_policy'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND s.settings_version_id = applied.id;

-------------------------------------------------------------------------------
-- 3) Helper functions for normalized snapshots, diffs, notifications, and tasks
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_text_v1(
  p_policy JSONB,
  p_path TEXT[],
  p_default TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(NULLIF(btrim(p_policy #>> p_path), ''), p_default);
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_request_type_key_v1(
  p_request_type TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE lower(COALESCE(NULLIF(btrim(p_request_type), ''), ''))
    WHEN 'reschedule' THEN 'reschedule_date'
    WHEN 'reschedule_date' THEN 'reschedule_date'
    WHEN 'location_change' THEN 'location_change'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_policy_action_key_v1(
  p_request_type TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE public.public_tracking_request_type_key_v1(p_request_type)
    WHEN 'reschedule_date' THEN 'reschedule'
    WHEN 'location_change' THEN 'location_change'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_execution_mode_v1(
  p_policy JSONB,
  p_request_type TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_action_key TEXT := public.public_tracking_policy_action_key_v1(p_request_type);
  v_mode TEXT;
BEGIN
  IF v_action_key IS NULL THEN
    RETURN 'review_required';
  END IF;

  v_mode := lower(COALESCE(NULLIF(btrim(p_policy #>> ARRAY['actions', v_action_key, 'execution_mode']), ''), 'auto_apply_with_fallback_to_review'));
  IF v_mode NOT IN ('review_required', 'auto_apply', 'auto_apply_with_fallback_to_review') THEN
    RETURN 'review_required';
  END IF;

  RETURN v_mode;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_short_address_value_v1(
  p_sa_short_code TEXT,
  p_building_number TEXT,
  p_postal_code TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(
    NULLIF(btrim(p_sa_short_code), ''),
    NULLIF(trim(concat_ws(' ', NULLIF(btrim(p_building_number), ''), NULLIF(btrim(p_postal_code), ''))), '')
  );
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_shipment_snapshot_v1(
  p_shipment_id UUID,
  p_client_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'shipment_id', s.id,
      'tracking_number', s.tracking_number,
      'client_reference_number', NULLIF(btrim(s.client_reference_number), ''),
      'carrier_reference_number', NULLIF(btrim(s.carrier_reference_number), ''),
      'shipment_status', s.status,
      'service_type', s.service_type,
      'promised_delivery_date', s.promised_delivery_date,
      'promised_delivery_at', s.promised_delivery_at,
      'promised_window_start_at', s.promised_window_start_at,
      'promised_window_end_at', s.promised_window_end_at,
      'address', jsonb_strip_nulls(
        jsonb_build_object(
          'address_id', a.id,
          'raw_input', NULLIF(btrim(a.raw_input), ''),
          'line1', NULLIF(btrim(a.line1), ''),
          'line2', NULLIF(btrim(a.line2), ''),
          'district', NULLIF(btrim(a.district), ''),
          'city', NULLIF(btrim(a.city), ''),
          'province', NULLIF(btrim(a.province), ''),
          'postal_code', NULLIF(btrim(a.postal_code), ''),
          'country', NULLIF(btrim(a.country), ''),
          'building_number', NULLIF(btrim(a.building_number), ''),
          'short_national_address', public.public_tracking_short_address_value_v1(a.sa_short_code, a.building_number, a.postal_code),
          'map_pin', CASE
            WHEN a.coordinates IS NULL THEN NULL
            ELSE jsonb_build_object(
              'lat', round((ST_Y(a.coordinates::geometry)::numeric), 6),
              'lng', round((ST_X(a.coordinates::geometry)::numeric), 6)
            )
          END
        )
      ),
      'updated_at', s.updated_at
    )
  )
  FROM public.shipments s
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
   AND a.client_id = s.client_id
  WHERE s.id = p_shipment_id
    AND s.client_id = p_client_id
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_requested_snapshot_v1(
  p_request_type TEXT,
  p_before_snapshot JSONB,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_request_type TEXT := public.public_tracking_request_type_key_v1(p_request_type);
  v_before JSONB := COALESCE(p_before_snapshot, '{}'::jsonb);
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
BEGIN
  IF v_request_type = 'reschedule_date' THEN
    RETURN jsonb_set(
      v_before,
      ARRAY['promised_delivery_date'],
      to_jsonb(NULLIF(v_payload->>'requested_date', '')::date),
      TRUE
    );
  END IF;

  IF v_request_type = 'location_change' THEN
    RETURN public.deep_merge_jsonb(
      v_before,
      jsonb_strip_nulls(
        jsonb_build_object(
          'address', jsonb_strip_nulls(
            jsonb_build_object(
              'raw_input', NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), ''),
              'line1', NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), ''),
              'short_national_address', NULLIF(btrim(COALESCE(v_payload->>'short_national_address', '')), ''),
              'map_pin', CASE
                WHEN NULLIF(v_payload #>> ARRAY['map_pin','lat'], '') IS NOT NULL
                  AND NULLIF(v_payload #>> ARRAY['map_pin','lng'], '') IS NOT NULL
                THEN jsonb_build_object(
                  'lat', round((v_payload #>> ARRAY['map_pin','lat'])::numeric, 6),
                  'lng', round((v_payload #>> ARRAY['map_pin','lng'])::numeric, 6)
                )
                ELSE NULL
              END
            )
          ),
          'notes', NULLIF(btrim(COALESCE(v_payload->>'notes', '')), '')
        )
      )
    );
  END IF;

  RETURN v_before;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_jsonb_path_value_v1(
  p_payload JSONB,
  p_path TEXT[]
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(p_payload #> p_path, 'null'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_change_artifacts_v1(
  p_request_type TEXT,
  p_before_snapshot JSONB,
  p_requested_snapshot JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_request_type TEXT := public.public_tracking_request_type_key_v1(p_request_type);
  v_before JSONB := COALESCE(p_before_snapshot, '{}'::jsonb);
  v_requested JSONB := COALESCE(p_requested_snapshot, '{}'::jsonb);
  v_paths TEXT[][];
  v_path TEXT[];
  v_key TEXT;
  v_from JSONB;
  v_to JSONB;
  v_changed TEXT[] := ARRAY[]::TEXT[];
  v_diff JSONB := '{}'::jsonb;
  v_summary TEXT := NULL;
BEGIN
  IF v_request_type = 'reschedule_date' THEN
    v_paths := ARRAY[
      ARRAY['promised_delivery_date']
    ];
  ELSIF v_request_type = 'location_change' THEN
    v_paths := ARRAY[
      ARRAY['address','raw_input'],
      ARRAY['address','short_national_address'],
      ARRAY['address','map_pin','lat'],
      ARRAY['address','map_pin','lng'],
      ARRAY['notes']
    ];
  ELSE
    v_paths := ARRAY[]::TEXT[][];
  END IF;

  FOREACH v_path SLICE 1 IN ARRAY v_paths LOOP
    v_from := public.public_tracking_jsonb_path_value_v1(v_before, v_path);
    v_to := public.public_tracking_jsonb_path_value_v1(v_requested, v_path);
    IF v_from IS DISTINCT FROM v_to THEN
      v_key := array_to_string(v_path, '.');
      v_changed := array_append(v_changed, v_key);
      v_diff := v_diff || jsonb_build_object(
        v_key,
        jsonb_strip_nulls(jsonb_build_object('from', NULLIF(v_from, 'null'::jsonb), 'to', NULLIF(v_to, 'null'::jsonb)))
      );
    END IF;
  END LOOP;

  IF v_request_type = 'reschedule_date' THEN
    v_summary := format(
      'Delivery date %s -> %s',
      COALESCE(v_before->>'promised_delivery_date', 'unscheduled'),
      COALESCE(v_requested->>'promised_delivery_date', 'unscheduled')
    );
  ELSIF v_request_type = 'location_change' THEN
    v_summary := format(
      'Address %s -> %s',
      COALESCE(v_before #>> ARRAY['address','short_national_address'], v_before #>> ARRAY['address','raw_input'], 'current address'),
      COALESCE(v_requested #>> ARRAY['address','short_national_address'], v_requested #>> ARRAY['address','raw_input'], 'new address')
    );
  END IF;

  RETURN jsonb_build_object(
    'changed_fields', to_jsonb(COALESCE(v_changed, ARRAY[]::TEXT[])),
    'diff', COALESCE(v_diff, '{}'::jsonb),
    'change_summary', v_summary
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_event_payload_v1(
  p_request_type TEXT,
  p_before_snapshot JSONB,
  p_requested_snapshot JSONB,
  p_extra JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT public.deep_merge_jsonb(
    public.deep_merge_jsonb(
      jsonb_build_object(
        'change_type', public.public_tracking_request_type_key_v1(p_request_type),
        'before_snapshot', COALESCE(p_before_snapshot, '{}'::jsonb),
        'requested_snapshot', COALESCE(p_requested_snapshot, '{}'::jsonb)
      ),
      public.public_tracking_change_artifacts_v1(p_request_type, p_before_snapshot, p_requested_snapshot)
    ),
    COALESCE(p_extra, '{}'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_emit_support_message_v1(
  p_support_case_id UUID,
  p_organization_id UUID,
  p_direction TEXT,
  p_channel TEXT,
  p_actor_system TEXT,
  p_body TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.support_messages (
    support_case_id,
    organization_id,
    direction,
    channel,
    actor_system,
    body,
    metadata,
    created_at
  )
  VALUES (
    p_support_case_id,
    p_organization_id,
    lower(COALESCE(NULLIF(btrim(p_direction), ''), 'internal')),
    lower(COALESCE(NULLIF(btrim(p_channel), ''), 'internal')),
    NULLIF(btrim(p_actor_system), ''),
    COALESCE(NULLIF(btrim(p_body), ''), 'System note'),
    COALESCE(p_metadata, '{}'::jsonb),
    workflow_now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_enqueue_recipient_notification_v1(
  p_support_case_id UUID,
  p_organization_id UUID,
  p_recipient_id UUID,
  p_stage TEXT,
  p_message TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_recipient RECORD;
  v_channel TEXT := NULL;
  v_call_type TEXT := NULL;
  v_outbound_id UUID := NULL;
BEGIN
  IF p_recipient_id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'missing_recipient_id');
  END IF;

  SELECT r.id, NULLIF(btrim(r.email), '') AS email, NULLIF(btrim(r.phone_number), '') AS phone_number
    INTO v_recipient
    FROM public.recipients r
   WHERE r.id = p_recipient_id
   LIMIT 1;

  IF v_recipient.id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'recipient_not_found');
  END IF;

  IF v_recipient.email IS NOT NULL THEN
    v_channel := 'email';
    v_call_type := 'comms_email';
  ELSIF v_recipient.phone_number IS NOT NULL THEN
    v_channel := 'sms';
    v_call_type := 'comms_sms';
  ELSE
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'recipient_contact_missing');
  END IF;

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    context,
    correlation_id
  )
  VALUES (
    v_call_type,
    'recipient',
    p_recipient_id,
    'POST',
    format('comms://%s', v_channel),
    '{}'::jsonb,
    jsonb_strip_nulls(
      jsonb_build_object(
        'stage', p_stage,
        'message', p_message,
        'support_case_id', p_support_case_id,
        'payload', COALESCE(p_payload, '{}'::jsonb)
      )
    ),
    100,
    3,
    jsonb_build_object(
      'source', 'public_tracking',
      'support_case_id', p_support_case_id,
      'stage', p_stage,
      'organization_id', p_organization_id
    ),
    NULL
  )
  RETURNING id INTO v_outbound_id;

  PERFORM public.log_decision(
    p_organization_id := p_organization_id,
    p_decision_category := 'comms_scheduling',
    p_resource_type := 'support_case',
    p_resource_id := p_support_case_id,
    p_decision_point := 'public_tracking_enqueue_recipient_notification_v1',
    p_decision_outcome := 'queued',
    p_performed_by_system := 'public_tracking',
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_build_object(
      'stage', p_stage,
      'channel', v_channel,
      'outbound_call_id', v_outbound_id
    ),
    p_decision_reason := NULL
  );

  RETURN jsonb_build_object('queued', TRUE, 'channel', v_channel, 'outbound_call_id', v_outbound_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_create_reviewer_task_v1(
  p_support_case_id UUID,
  p_organization_id UUID,
  p_policy JSONB,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_enabled BOOLEAN := public.public_tracking_bool_v1(p_policy, ARRAY['notifications','reviewer_in_app'], TRUE);
  v_task_org_slug TEXT;
  v_task_org_id UUID;
  v_task_type_key TEXT;
  v_task_queue TEXT;
  v_task_priority INT;
  v_task_sla_minutes INT;
  v_task_id UUID;
  v_workflow_run_id UUID;
BEGIN
  IF NOT v_enabled OR p_support_case_id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'disabled');
  END IF;

  v_task_org_slug := public.public_tracking_text_v1(p_policy, ARRAY['notifications','task','organization_slug'], 'global-root');
  SELECT o.id INTO v_task_org_id
  FROM public.organizations o
  WHERE o.slug = v_task_org_slug
  LIMIT 1;

  IF v_task_org_id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'task_org_missing', 'organization_slug', v_task_org_slug);
  END IF;

  v_task_type_key := public.public_tracking_text_v1(
    p_policy,
    ARRAY['notifications','task','task_type_key'],
    'customer_shipment_change_review'
  );
  v_task_queue := NULLIF(btrim(COALESCE(p_policy #>> ARRAY['notifications','task','queue_key'], '')), '');
  v_task_priority := public.public_tracking_int_v1(p_policy, ARRAY['notifications','task','priority'], 40, 0, 1000);
  v_task_sla_minutes := public.public_tracking_int_v1(p_policy, ARRAY['notifications','task','sla_minutes'], 60, 1, 10080);

  SELECT t.task_id, t.workflow_run_id
    INTO v_task_id, v_workflow_run_id
    FROM public.create_task_system_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', jsonb_build_object('organization_id', v_task_org_id),
          'resource_type', 'support_case',
          'resource_id', p_support_case_id,
          'queue_key', v_task_queue,
          'priority', v_task_priority,
          'sla_minutes', v_task_sla_minutes,
          'idempotency_key', format('customer_shipment_change_review:%s', p_support_case_id),
          'metadata', COALESCE(p_metadata, '{}'::jsonb),
          'actor_system', 'public_tracking'
        )
      )
    ) AS t
   LIMIT 1;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'queued', TRUE,
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_assert_reviewer_v1()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := NULL;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role' THEN
    RETURN NULL;
  END IF;

  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'customer shipment change review requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('customer_shipment_changes', 'write') THEN
    RAISE EXCEPTION 'customer shipment change review requires manual_review.resolve capability'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_user_id;
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Shared canonical shipment address mutation path
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shipment_apply_destination_address_change_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_shipment_id UUID := NULL;
  v_client_id UUID := NULL;
  v_support_case_id UUID := NULL;
  v_request_type_key TEXT := public.public_tracking_request_type_key_v1(v_input->>'request_type_key');
  v_performed_by_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'performed_by_system', '')), ''), 'public_tracking');
  v_action_type TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'action_type', '')), ''), 'address_update');
  v_action_category TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'action_category', '')), ''), 'administrative');
  v_re_geocode BOOLEAN := COALESCE((v_input->>'re_geocode')::BOOLEAN, TRUE);
  v_geocode_template_name TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'geocode_template_name', '')), ''), 'workflow_geocoding_standard');
  v_address_text TEXT := NULLIF(btrim(COALESCE(v_input->>'address_text', '')), '');
  v_short_national_address TEXT := NULLIF(btrim(COALESCE(v_input->>'short_national_address', '')), '');
  v_notes TEXT := NULLIF(btrim(COALESCE(v_input->>'notes', '')), '');
  v_lat NUMERIC := NULL;
  v_lng NUMERIC := NULL;
  v_shipment RECORD;
  v_existing_address RECORD;
  v_address_id UUID;
  v_geocode_template_id UUID := NULL;
  v_geocode_run_id UUID := NULL;
  v_action_id UUID := NULL;
BEGIN
  BEGIN v_shipment_id := NULLIF(v_input->>'shipment_id', '')::UUID; EXCEPTION WHEN others THEN v_shipment_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  BEGIN v_lat := NULLIF(v_input #>> ARRAY['map_pin','lat'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lat := NULL; END;
  BEGIN v_lng := NULLIF(v_input #>> ARRAY['map_pin','lng'], '')::NUMERIC; EXCEPTION WHEN others THEN v_lng := NULL; END;

  IF v_shipment_id IS NULL OR v_client_id IS NULL OR v_address_text IS NULL OR v_short_national_address IS NULL OR v_lat IS NULL OR v_lng IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  SELECT
    s.id,
    s.organization_id,
    s.client_id,
    s.sender_id,
    s.status,
    s.tracking_number,
    s.destination_address_id
  INTO v_shipment
  FROM public.shipments s
  WHERE s.id = v_shipment_id
    AND s.client_id = v_client_id
  FOR UPDATE;

  IF v_shipment.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'shipment_not_found'));
  END IF;

  IF lower(COALESCE(v_shipment.status, '')) IN ('delivered', 'cancelled', 'canceled') THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'shipment_state_blocked', 'status', v_shipment.status)
    );
  END IF;

  SELECT
    a.id,
    a.city,
    a.district,
    a.province,
    a.postal_code,
    a.country,
    a.building_number
  INTO v_existing_address
  FROM public.addresses a
  WHERE a.id = v_shipment.destination_address_id
    AND a.client_id = v_shipment.client_id
  LIMIT 1;

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    sa_short_code,
    normalized_line1,
    normalized_line2,
    district,
    city,
    province,
    postal_code,
    country,
    line1,
    line2,
    validation_status,
    coordinates,
    additional_directions,
    created_at,
    updated_at
  )
  VALUES (
    gen_random_uuid(),
    v_shipment.organization_id,
    v_shipment.client_id,
    v_address_text,
    v_short_national_address,
    v_address_text,
    NULL,
    NULLIF(v_existing_address.district, ''),
    COALESCE(NULLIF(v_existing_address.city, ''), 'Pending geocode'),
    COALESCE(NULLIF(v_existing_address.province, ''), 'Pending geocode'),
    NULLIF(v_existing_address.postal_code, ''),
    COALESCE(NULLIF(v_existing_address.country, ''), 'SA'),
    v_address_text,
    NULL,
    'pending',
    ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography,
    v_notes,
    workflow_now(),
    workflow_now()
  )
  RETURNING id INTO v_address_id;

  UPDATE public.shipments
     SET destination_address_id = v_address_id,
         updated_at = workflow_now()
   WHERE id = v_shipment.id
     AND client_id = v_shipment.client_id;

  IF v_re_geocode THEN
    SELECT wt.id
      INTO v_geocode_template_id
      FROM public.workflow_templates wt
     WHERE wt.name = v_geocode_template_name
       AND wt.status = 'active'
     ORDER BY wt.updated_at DESC NULLS LAST
     LIMIT 1;

    IF v_geocode_template_id IS NOT NULL THEN
      v_geocode_run_id := public.start_workflow_run(
        v_geocode_template_id,
        jsonb_build_object(
          'organization_id', v_shipment.organization_id,
          'client_id', v_shipment.client_id,
          'sender_id', v_shipment.sender_id,
          'shipment_id', v_shipment.id,
          'destination_address_id', v_address_id
        )
      );
    END IF;
  END IF;

  v_action_id := workflow_handlers.record_shipment_action_v1(
    v_shipment.id,
    lower(v_action_type),
    lower(v_action_category),
    jsonb_strip_nulls(
      jsonb_build_object(
        'address_id', v_address_id,
        'support_case_id', v_support_case_id,
        'request_type_key', v_request_type_key,
        'geocode_workflow_run_id', v_geocode_run_id,
        'short_national_address', v_short_national_address,
        'map_pin', jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6))
      )
    ),
    v_notes,
    NULL,
    v_performed_by_system,
    NULL
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'shipment_id', v_shipment.id,
      'address_id', v_address_id,
      'shipment_action_id', v_action_id,
      'geocode_workflow_run_id', v_geocode_run_id
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Canonical apply RPC
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_apply_support_case_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_support_case_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'public_tracking');
  v_case RECORD;
  v_policy JSONB;
  v_result JSONB;
  v_current_snapshot JSONB;
  v_applied_snapshot JSONB;
  v_action_id UUID := NULL;
BEGIN
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;

  IF v_support_case_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'support_case_id_required'));
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.client_id,
    sc.sender_id,
    sc.resource_id,
    sc.status,
    sc.status_reason,
    sc.version,
    sc.request_source,
    sc.request_type_key,
    sc.metadata
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = v_support_case_id
  FOR UPDATE;

  IF v_case.id IS NULL OR v_case.request_source <> 'public_tracking' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_case.status = 'resolved' AND v_case.status_reason = 'applied' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', 'applied',
      'already_processed', TRUE,
      'current_snapshot', COALESCE(v_case.metadata->'current_snapshot', '{}'::jsonb)
    );
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_case.organization_id,
    'client_id', v_case.client_id,
    'sender_id', v_case.sender_id
  ));

  IF v_case.request_type_key = 'reschedule_date' THEN
    v_result := public.reserve_delivery_slot_v1(
      jsonb_build_object(
        'shipment_id', v_case.resource_id,
        'client_id', v_case.client_id,
        'slot_date', v_case.metadata #>> ARRAY['requested_snapshot','promised_delivery_date'],
        'performed_by_system', v_actor_system
      )
    );

    IF COALESCE((v_result->>'reserved')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object(
          'code', COALESCE(v_result->>'reason', 'apply_failed'),
          'message', COALESCE(v_result->>'reason', 'apply_failed')
        ),
        'current_snapshot', COALESCE(v_case.metadata->'current_snapshot', v_case.metadata->'before_snapshot', '{}'::jsonb)
      );
    END IF;
  ELSIF v_case.request_type_key = 'location_change' THEN
    v_result := public.shipment_apply_destination_address_change_v1(
      jsonb_build_object(
        'shipment_id', v_case.resource_id,
        'client_id', v_case.client_id,
        'support_case_id', v_case.id,
        'request_type_key', v_case.request_type_key,
        'performed_by_system', v_actor_system,
        'address_text', v_case.metadata #>> ARRAY['requested_snapshot','address','raw_input'],
        'short_national_address', v_case.metadata #>> ARRAY['requested_snapshot','address','short_national_address'],
        'map_pin', COALESCE(v_case.metadata #> ARRAY['requested_snapshot','address','map_pin'], '{}'::jsonb),
        'notes', v_case.metadata->>'notes'
      )
    );

    IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object(
          'code', COALESCE(v_result #>> ARRAY['error','code'], 'apply_failed'),
          'message', COALESCE(v_result #>> ARRAY['error','code'], 'apply_failed')
        ),
        'current_snapshot', COALESCE(v_case.metadata->'current_snapshot', v_case.metadata->'before_snapshot', '{}'::jsonb)
      );
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_current_snapshot := public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id);
  v_applied_snapshot := COALESCE(v_current_snapshot, '{}'::jsonb);

  IF v_case.request_type_key = 'reschedule_date' THEN
    v_action_id := workflow_handlers.record_shipment_action_v1(
      v_case.resource_id,
      'customer_change_applied',
      'administrative',
      jsonb_build_object(
        'support_case_id', v_case.id,
        'request_type_key', v_case.request_type_key,
        'changed_fields', COALESCE(v_case.metadata->'changed_fields', '[]'::jsonb),
        'diff', COALESCE(v_case.metadata->'diff', '{}'::jsonb),
        'reservation_result', v_result
      ),
      NULL,
      NULL,
      v_actor_system,
      NULL
    );
  END IF;

  UPDATE public.support_cases
     SET status = 'resolved',
         status_reason = 'applied',
         resolved_at = COALESCE(resolved_at, workflow_now()),
         version = version + 1,
         metadata = public.deep_merge_jsonb(
           metadata,
           jsonb_strip_nulls(
             jsonb_build_object(
               'request_outcome', 'applied',
               'applied_snapshot', v_applied_snapshot,
               'current_snapshot', v_current_snapshot,
               'applied_at', workflow_now(),
               'last_apply_error', NULL
             )
           )
         ),
         updated_at = workflow_now()
   WHERE id = v_case.id
   RETURNING version, metadata INTO v_case.version, v_case.metadata;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case.id,
    v_case.organization_id,
    'applied',
    v_case.status,
    'resolved',
    v_actor_user_id,
    v_actor_system,
    public.deep_merge_jsonb(
      public.public_tracking_event_payload_v1(
        v_case.request_type_key,
        COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
        COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
        '{}'::jsonb
      ),
      jsonb_build_object(
        'apply_outcome', 'applied',
        'applied_snapshot', v_applied_snapshot,
        'current_snapshot', v_current_snapshot,
        'shipment_action_id', v_action_id
      )
    ),
    format('customer-shipment-change:applied:%s:%s', v_case.id, v_case.version),
    v_case.version,
    workflow_now()
  );

  PERFORM public.public_tracking_emit_support_message_v1(
    v_case.id,
    v_case.organization_id,
    'internal',
    'internal',
    v_actor_system,
    format('Customer shipment change applied (%s).', v_case.request_type_key),
    jsonb_build_object('request_outcome', 'applied')
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_applied'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case.id,
      v_case.organization_id,
      NULLIF(v_case.metadata->>'recipient_id', '')::UUID,
      'applied',
      format('Your %s request was applied.', replace(v_case.request_type_key, '_', ' ')),
      jsonb_build_object('change_summary', v_case.metadata->>'change_summary')
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case.id,
    'outcome', 'applied',
    'current_snapshot', v_current_snapshot,
    'applied_snapshot', v_applied_snapshot
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_submit_request_v2(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_token TEXT := NULLIF(btrim(COALESCE(v_input->>'session_token', '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_request_type TEXT := public.public_tracking_request_type_key_v1(v_input->>'request_type');
  v_payload JSONB := COALESCE(v_input->'payload', '{}'::jsonb);
  v_requester_channel TEXT := COALESCE(NULLIF(btrim(COALESCE(v_input->>'requester_channel', '')), ''), 'public_tracking');
  v_global_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_rate RECORD;
  v_session RECORD;
  v_policy JSONB;
  v_action_key TEXT;
  v_execution_mode TEXT;
  v_enabled BOOLEAN := FALSE;
  v_priority TEXT := 'medium';
  v_sla_minutes INT := 60;
  v_requested_date DATE := NULL;
  v_available_date BOOLEAN := FALSE;
  v_case_id UUID;
  v_case_version INT;
  v_idempotency_key TEXT;
  v_before_snapshot JSONB;
  v_requested_snapshot JSONB;
  v_current_snapshot JSONB;
  v_event_payload JSONB;
  v_task_result JSONB := '{}'::jsonb;
  v_apply_result JSONB := '{}'::jsonb;
  v_case_metadata JSONB;
BEGIN
  IF v_token IS NULL OR v_ip_hash IS NULL OR v_request_type IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  SELECT * INTO v_rate
  FROM public.public_tracking_rate_limit_state_v1(v_global_policy, 'request', v_ip_hash)
  LIMIT 1;

  IF COALESCE(v_rate.recent_requests, 0) >= COALESCE(v_rate.max_requests, 1) THEN
    PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'rate_limited');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
  END IF;

  SELECT
    ts.id,
    ts.organization_id,
    ts.client_id,
    ts.sender_id,
    ts.shipment_id,
    ts.recipient_id,
    s.tracking_number,
    s.client_reference_number,
    s.carrier_reference_number
  INTO v_session
  FROM public.tracking_sessions ts
  JOIN public.shipments s
    ON s.id = ts.shipment_id
   AND s.client_id = ts.client_id
  WHERE ts.status = 'active'
    AND (ts.expires_at IS NULL OR ts.expires_at > workflow_now())
    AND ts.token_hash = crypt(v_token, ts.token_hash)
  ORDER BY ts.created_at DESC
  LIMIT 1;

  IF v_session.id IS NULL THEN
    PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_session');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_session.organization_id,
    'client_id', v_session.client_id,
    'sender_id', v_session.sender_id
  ));
  v_action_key := public.public_tracking_policy_action_key_v1(v_request_type);
  v_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions', v_action_key, 'enabled'], TRUE);
  v_priority := public.public_tracking_text_v1(v_policy, ARRAY['actions', v_action_key, 'priority'], 'medium');
  v_sla_minutes := public.public_tracking_int_v1(v_policy, ARRAY['actions', v_action_key, 'sla_minutes'], 60, 1, 10080);
  v_execution_mode := public.public_tracking_execution_mode_v1(v_policy, v_request_type);

  IF v_request_type = 'reschedule_date' THEN
    BEGIN
      v_requested_date := NULLIF(v_payload->>'requested_date', '')::DATE;
    EXCEPTION
      WHEN others THEN
        v_requested_date := NULL;
    END;

    IF v_requested_date IS NOT NULL THEN
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM public.list_delivery_slots_v1(jsonb_build_object(
            'shipment_id', v_session.shipment_id,
            'client_id', v_session.client_id,
            'start_date', workflow_now()::date,
            'days', public.public_tracking_int_v1(v_policy, ARRAY['actions','reschedule','horizon_days'], 7, 1, 60),
            'include_unavailable', FALSE
          ))
          WHERE is_available IS TRUE
            AND slot_date = v_requested_date
        )
        INTO v_available_date;
      EXCEPTION
        WHEN others THEN
          v_available_date := FALSE;
      END;
    END IF;

    IF NOT v_enabled OR v_requested_date IS NULL OR v_available_date IS DISTINCT FROM TRUE THEN
      PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_request', v_session.organization_id, v_session.client_id, v_session.shipment_id, v_session.id);
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;
  ELSIF v_request_type = 'location_change' THEN
    IF NOT v_enabled
      OR NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), '') IS NULL
      OR NULLIF(btrim(COALESCE(v_payload->>'short_national_address', '')), '') IS NULL
      OR NULLIF(v_payload #>> ARRAY['map_pin','lat'], '') IS NULL
      OR NULLIF(v_payload #>> ARRAY['map_pin','lng'], '') IS NULL THEN
      PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_request', v_session.organization_id, v_session.client_id, v_session.shipment_id, v_session.id);
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_before_snapshot := public.public_tracking_shipment_snapshot_v1(v_session.shipment_id, v_session.client_id);
  v_requested_snapshot := public.public_tracking_requested_snapshot_v1(v_request_type, v_before_snapshot, v_payload);
  v_current_snapshot := v_before_snapshot;
  v_event_payload := public.public_tracking_event_payload_v1(v_request_type, v_before_snapshot, v_requested_snapshot);

  v_case_metadata := jsonb_strip_nulls(
    jsonb_build_object(
      'source', 'public_tracking',
      'request_type', v_request_type,
      'request_outcome', 'pending_review',
      'requester_channel', v_requester_channel,
      'session_id', v_session.id,
      'recipient_id', v_session.recipient_id,
      'tracking_number', v_session.tracking_number,
      'client_reference_number', NULLIF(btrim(v_session.client_reference_number), ''),
      'carrier_reference_number', NULLIF(btrim(v_session.carrier_reference_number), ''),
      'execution_mode', v_execution_mode,
      'notes', NULLIF(btrim(COALESCE(v_payload->>'notes', '')), ''),
      'before_snapshot', v_before_snapshot,
      'requested_snapshot', v_requested_snapshot,
      'current_snapshot', v_current_snapshot
    )
  );
  v_case_metadata := public.deep_merge_jsonb(v_case_metadata, v_event_payload);

  v_idempotency_key := encode(
    digest(
      v_session.shipment_id::TEXT || ':' || v_request_type || ':' || COALESCE(v_requested_snapshot::TEXT, ''),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.support_cases (
    organization_id,
    client_id,
    sender_id,
    resource_type,
    resource_id,
    status,
    priority,
    sla_minutes,
    sla_due_at,
    opened_at,
    idempotency_key,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_session.organization_id,
    v_session.client_id,
    v_session.sender_id,
    'shipment',
    v_session.shipment_id,
    'open',
    v_priority,
    v_sla_minutes,
    workflow_now() + make_interval(mins => v_sla_minutes),
    workflow_now(),
    v_idempotency_key,
    v_case_metadata,
    workflow_now(),
    workflow_now()
  )
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING id, version INTO v_case_id, v_case_version;

  IF v_case_id IS NULL THEN
    SELECT sc.id, sc.version, sc.metadata
      INTO v_case_id, v_case_version, v_case_metadata
      FROM public.support_cases sc
     WHERE sc.organization_id = v_session.organization_id
       AND sc.idempotency_key = v_idempotency_key
     LIMIT 1;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', FALSE,
      'deduped', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', COALESCE(v_case_metadata->>'request_outcome', 'pending_review'),
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case_id,
    v_session.organization_id,
    'requested',
    NULL,
    'open',
    'public_tracking',
    public.deep_merge_jsonb(v_event_payload, jsonb_build_object('request_outcome', 'pending_review')),
    format('customer-shipment-change:requested:%s', v_case_id),
    COALESCE(v_case_version, 1),
    workflow_now()
  );

  PERFORM public.public_tracking_emit_support_message_v1(
    v_case_id,
    v_session.organization_id,
    'inbound',
    'in_app',
    'public_tracking',
    COALESCE(
      NULLIF(btrim(COALESCE(v_payload->>'notes', '')), ''),
      format('Customer requested %s via public tracking.', replace(v_request_type, '_', ' '))
    ),
    jsonb_build_object('request_type', v_request_type)
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_received'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case_id,
      v_session.organization_id,
      v_session.recipient_id,
      'received',
      format('We received your %s request.', replace(v_request_type, '_', ' ')),
      jsonb_build_object('change_summary', v_case_metadata->>'change_summary')
    );
  END IF;

  IF v_execution_mode = 'review_required' THEN
    BEGIN
      v_task_result := public.public_tracking_create_reviewer_task_v1(
        v_case_id,
        v_session.organization_id,
        v_policy,
        jsonb_build_object(
          'support_case_id', v_case_id,
          'tracking_number', v_session.tracking_number,
          'change_summary', v_case_metadata->>'change_summary',
          'request_type', v_request_type
        )
      );
    EXCEPTION
      WHEN others THEN
        v_task_result := jsonb_build_object('queued', FALSE, 'reason', left(SQLERRM, 800));
    END;

    UPDATE public.support_cases
       SET metadata = public.deep_merge_jsonb(
             metadata,
             jsonb_build_object(
               'request_outcome', 'pending_review',
               'review_task', v_task_result
             )
           ),
           updated_at = workflow_now()
     WHERE id = v_case_id;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', 'pending_review',
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  v_apply_result := public.public_tracking_apply_support_case_v1(
    jsonb_build_object(
      'support_case_id', v_case_id,
      'actor_system', 'public_tracking'
    )
  );

  IF COALESCE((v_apply_result->>'ok')::BOOLEAN, FALSE) THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', 'applied',
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  IF v_execution_mode = 'auto_apply_with_fallback_to_review' THEN
    BEGIN
      v_task_result := public.public_tracking_create_reviewer_task_v1(
        v_case_id,
        v_session.organization_id,
        v_policy,
        jsonb_build_object(
          'support_case_id', v_case_id,
          'tracking_number', v_session.tracking_number,
          'change_summary', v_case_metadata->>'change_summary',
          'request_type', v_request_type,
          'fallback_reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed')
        )
      );
    EXCEPTION
      WHEN others THEN
        v_task_result := jsonb_build_object('queued', FALSE, 'reason', left(SQLERRM, 800));
    END;

    UPDATE public.support_cases
       SET status = 'open',
           status_reason = 'apply_failed_pending_review',
           version = version + 1,
           metadata = public.deep_merge_jsonb(
             metadata,
             jsonb_strip_nulls(
               jsonb_build_object(
                 'request_outcome', 'pending_review',
                 'last_apply_error', v_apply_result->'error',
                 'review_task', v_task_result
               )
             )
           ),
           updated_at = workflow_now()
     WHERE id = v_case_id
     RETURNING version INTO v_case_version;

    INSERT INTO public.support_case_events (
      support_case_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_system,
      payload,
      idempotency_key,
      case_version,
      created_at
    )
    VALUES (
      v_case_id,
      v_session.organization_id,
      'apply_failed_pending_review',
      'open',
      'open',
      'public_tracking',
      public.public_tracking_event_payload_v1(
        v_request_type,
        v_before_snapshot,
        v_requested_snapshot,
        jsonb_build_object(
          'apply_outcome', 'failed_pending_review',
          'failure_reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed'),
          'review_task', v_task_result,
          'current_snapshot', v_before_snapshot
        )
      ),
      format('customer-shipment-change:apply-failed-pending-review:%s:%s', v_case_id, v_case_version),
      v_case_version,
      workflow_now()
    );

    RETURN jsonb_build_object(
      'ok', TRUE,
      'submitted', TRUE,
      'support_case_id', v_case_id,
      'request_type', v_request_type,
      'outcome', 'pending_review',
      'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
    );
  END IF;

  UPDATE public.support_cases
     SET status = 'resolved',
         status_reason = 'rejected',
         resolved_at = workflow_now(),
         version = version + 1,
         metadata = public.deep_merge_jsonb(
           metadata,
           jsonb_build_object(
             'request_outcome', 'rejected',
             'last_apply_error', v_apply_result->'error',
             'current_snapshot', v_before_snapshot
           )
         ),
         updated_at = workflow_now()
   WHERE id = v_case_id
   RETURNING version INTO v_case_version;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case_id,
    v_session.organization_id,
    'rejected',
    'open',
    'resolved',
    'public_tracking',
    public.public_tracking_event_payload_v1(
      v_request_type,
      v_before_snapshot,
      v_requested_snapshot,
      jsonb_build_object(
        'apply_outcome', 'rejected',
        'failure_reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed'),
        'current_snapshot', v_before_snapshot
      )
    ),
    format('customer-shipment-change:rejected:%s:%s', v_case_id, v_case_version),
    v_case_version,
    workflow_now()
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_rejected'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case_id,
      v_session.organization_id,
      v_session.recipient_id,
      'rejected',
      format('Your %s request was rejected.', replace(v_request_type, '_', ' ')),
      jsonb_build_object('reason', COALESCE(v_apply_result #>> ARRAY['error','code'], 'apply_failed'))
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'submitted', TRUE,
    'support_case_id', v_case_id,
    'request_type', v_request_type,
    'outcome', 'rejected',
    'tracking', public.public_tracking_build_payload_v1(v_session.id, v_policy)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_create_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.public_tracking_submit_request_v2(p_input);
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_review_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_support_case_id UUID := NULL;
  v_decision TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_input->>'decision', '')), ''), ''));
  v_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'reason', '')), '');
  v_user_id UUID := NULL;
  v_case RECORD;
  v_policy JSONB;
  v_result JSONB := '{}'::jsonb;
  v_current_snapshot JSONB := '{}'::jsonb;
BEGIN
  BEGIN v_support_case_id := NULLIF(v_input->>'support_case_id', '')::UUID; EXCEPTION WHEN others THEN v_support_case_id := NULL; END;
  v_user_id := public.public_tracking_assert_reviewer_v1();

  IF v_support_case_id IS NULL OR v_decision NOT IN ('approve', 'approved', 'reject', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  IF v_decision = 'approve' THEN
    v_decision := 'approved';
  ELSIF v_decision = 'reject' THEN
    v_decision := 'rejected';
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.client_id,
    sc.sender_id,
    sc.resource_id,
    sc.status,
    sc.status_reason,
    sc.version,
    sc.request_source,
    sc.request_type_key,
    sc.metadata
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = v_support_case_id
  FOR UPDATE;

  IF v_case.id IS NULL OR v_case.request_source <> 'public_tracking' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF NOT public.is_platform_user() AND v_case.organization_id <> public.current_user_org_id() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'forbidden'));
  END IF;

  IF v_case.status = 'resolved' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', COALESCE(v_case.metadata->>'request_outcome', CASE WHEN v_case.status_reason = 'applied' THEN 'applied' ELSE 'rejected' END),
      'already_processed', TRUE
    );
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_case.organization_id,
    'client_id', v_case.client_id,
    'sender_id', v_case.sender_id
  ));

  IF v_decision = 'approved' THEN
    v_result := public.public_tracking_apply_support_case_v1(
      jsonb_build_object(
        'support_case_id', v_case.id,
        'actor_user_id', v_user_id,
        'actor_system', 'console.customer_shipment_changes'
      )
    );

    IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
      v_current_snapshot := COALESCE(
        v_result->'current_snapshot',
        public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id),
        '{}'::jsonb
      );

      UPDATE public.support_cases
         SET status = 'open',
             status_reason = 'apply_failed_pending_review',
             version = version + 1,
             metadata = public.deep_merge_jsonb(
               metadata,
               jsonb_strip_nulls(
                 jsonb_build_object(
                   'request_outcome', 'pending_review',
                   'last_apply_error', v_result->'error',
                   'current_snapshot', v_current_snapshot,
                   'review_reason', v_reason
                 )
               )
             ),
             updated_at = workflow_now()
       WHERE id = v_case.id
       RETURNING version, metadata INTO v_case.version, v_case.metadata;

      INSERT INTO public.support_case_events (
        support_case_id,
        organization_id,
        event_type,
        from_status,
        to_status,
        actor_user_id,
        actor_system,
        payload,
        idempotency_key,
        case_version,
        created_at
      )
      VALUES (
        v_case.id,
        v_case.organization_id,
        'apply_failed',
        v_case.status,
        'open',
        v_user_id,
        'console.customer_shipment_changes',
        public.public_tracking_event_payload_v1(
          v_case.request_type_key,
          COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
          COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
          jsonb_strip_nulls(
            jsonb_build_object(
              'apply_outcome', 'failed',
              'failure_reason', COALESCE(v_result #>> ARRAY['error','code'], 'apply_failed'),
              'current_snapshot', v_current_snapshot,
              'reason', v_reason
            )
          )
        ),
        format('customer-shipment-change:review-apply-failed:%s:%s', v_case.id, v_case.version),
        v_case.version,
        workflow_now()
      );

      RETURN v_result;
    END IF;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'support_case_id', v_case.id,
      'outcome', 'applied',
      'current_snapshot', v_result->'current_snapshot'
    );
  END IF;

  v_current_snapshot := public.public_tracking_shipment_snapshot_v1(v_case.resource_id, v_case.client_id);

  UPDATE public.support_cases
     SET status = 'resolved',
         status_reason = 'rejected',
         resolved_at = workflow_now(),
         version = version + 1,
         metadata = public.deep_merge_jsonb(
           metadata,
           jsonb_strip_nulls(
             jsonb_build_object(
               'request_outcome', 'rejected',
               'current_snapshot', v_current_snapshot,
               'review_reason', v_reason
             )
           )
         ),
         updated_at = workflow_now()
   WHERE id = v_case.id
   RETURNING version, metadata INTO v_case.version, v_case.metadata;

  INSERT INTO public.support_case_events (
    support_case_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    case_version,
    created_at
  )
  VALUES (
    v_case.id,
    v_case.organization_id,
    'rejected',
    v_case.status,
    'resolved',
    v_user_id,
    'console.customer_shipment_changes',
    public.public_tracking_event_payload_v1(
      v_case.request_type_key,
      COALESCE(v_case.metadata->'before_snapshot', '{}'::jsonb),
      COALESCE(v_case.metadata->'requested_snapshot', '{}'::jsonb),
      jsonb_strip_nulls(
        jsonb_build_object(
          'reason', v_reason,
          'current_snapshot', v_current_snapshot,
          'request_outcome', 'rejected'
        )
      )
    ),
    format('customer-shipment-change:review-rejected:%s:%s', v_case.id, v_case.version),
    v_case.version,
    workflow_now()
  );

  PERFORM public.public_tracking_emit_support_message_v1(
    v_case.id,
    v_case.organization_id,
    'internal',
    'internal',
    'console.customer_shipment_changes',
    COALESCE(v_reason, format('Customer shipment change rejected (%s).', v_case.request_type_key)),
    jsonb_build_object('request_outcome', 'rejected')
  );

  IF public.public_tracking_bool_v1(v_policy, ARRAY['notifications','requester_rejected'], TRUE) THEN
    PERFORM public.public_tracking_enqueue_recipient_notification_v1(
      v_case.id,
      v_case.organization_id,
      NULLIF(v_case.metadata->>'recipient_id', '')::UUID,
      'rejected',
      format('Your %s request was rejected.', replace(v_case.request_type_key, '_', ' ')),
      jsonb_strip_nulls(jsonb_build_object('reason', v_reason))
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'support_case_id', v_case.id,
    'outcome', 'rejected',
    'current_snapshot', v_current_snapshot
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Refactor workflow handler to delegate to shared address mutation path
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_shipment_update_address_v1(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy JSONB := public.resolve_shipment_operation_policy_v1(v_ctx);
  v_target RECORD;
  v_result public.workflow_handler_response;
  v_event_id TEXT := workflow_handlers.resolve_event_id_v1(v_ctx);
  v_address JSONB := COALESCE(v_ctx->'address', v_ctx->'destination_address', '{}'::jsonb);
  v_apply JSONB;
BEGIN
  SELECT * INTO v_target FROM workflow_handlers.resolve_shipment_target_v1(v_ctx) LIMIT 1;
  IF v_target.shipment_id IS NULL THEN
    v_result.status := 'failed';
    v_result.last_error := 'shipment_not_found';
    v_result.operation_result := jsonb_build_object('error', 'shipment_not_found');
    RETURN v_result;
  END IF;

  v_apply := public.shipment_apply_destination_address_change_v1(
    jsonb_strip_nulls(
      jsonb_build_object(
        'shipment_id', v_target.shipment_id,
        'client_id', v_target.client_id,
        'request_type_key', 'location_change',
        'performed_by_system', 'workflow_handlers.execute_shipment_update_address_v1',
        'action_type', 'address_update',
        'action_category', 'administrative',
        're_geocode', COALESCE((v_policy#>>'{address,re_geocode}')::BOOLEAN, TRUE),
        'geocode_template_name', COALESCE(NULLIF(v_policy#>>'{address,geocode_template_name}', ''), NULLIF(v_policy#>>'{geocode,workflow_template_name}', ''), 'workflow_geocoding_standard'),
        'address_text', COALESCE(NULLIF(v_address->>'raw_input', ''), NULLIF(v_address->>'address_text', ''), NULLIF(v_address->>'line1', ''), NULLIF(v_ctx->>'address_text', '')),
        'short_national_address', COALESCE(NULLIF(v_address->>'short_national_address', ''), NULLIF(v_address->>'sa_short_code', ''), NULLIF(v_ctx->>'short_national_address', '')),
        'map_pin', COALESCE(v_address->'map_pin', v_address->'coordinates', v_ctx->'map_pin', '{}'::jsonb),
        'notes', COALESCE(NULLIF(v_address->>'notes', ''), NULLIF(v_ctx->>'notes', ''), NULL),
        'idempotency_key', v_event_id
      )
    )
  );

  IF COALESCE((v_apply->>'ok')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    v_result.status := 'failed';
    v_result.last_error := COALESCE(v_apply #>> ARRAY['error','code'], 'address_update_failed');
    v_result.operation_result := COALESCE(v_apply, jsonb_build_object('error', 'address_update_failed'));
    RETURN v_result;
  END IF;

  v_result.status := 'completed';
  v_result.retry_attempt := 1;
  v_result.max_retries := 1;
  v_result.context_patch := jsonb_build_object(
    'shipment', jsonb_build_object(
      'id', v_target.shipment_id,
      'tracking_number', v_target.tracking_number,
      'destination_address_id', v_apply->>'address_id'
    )
  );
  v_result.operation_result := v_apply;
  RETURN v_result;
END;
$function$;

-------------------------------------------------------------------------------
-- 7) API wrappers + least-privilege grants
-------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.public_tracking_submit_request_v2(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.public_tracking_submit_request_v2(p_input);
$function$;

CREATE OR REPLACE FUNCTION api.public_tracking_apply_support_case_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.public_tracking_apply_support_case_v1(p_input);
$function$;

CREATE OR REPLACE FUNCTION api.public_tracking_review_request_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.public_tracking_review_request_v1(p_input);
$function$;

CREATE OR REPLACE FUNCTION api.public_tracking_create_request_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.public_tracking_submit_request_v2(p_input);
$function$;

REVOKE ALL ON FUNCTION public.public_tracking_text_v1(JSONB, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_request_type_key_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_policy_action_key_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_execution_mode_v1(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_short_address_value_v1(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_shipment_snapshot_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_requested_snapshot_v1(TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_jsonb_path_value_v1(JSONB, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_change_artifacts_v1(TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_event_payload_v1(TEXT, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_emit_support_message_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_enqueue_recipient_notification_v1(UUID, UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_create_reviewer_task_v1(UUID, UUID, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_assert_reviewer_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shipment_apply_destination_address_change_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_apply_support_case_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_submit_request_v2(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_review_request_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.public_tracking_submit_request_v2(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.public_tracking_apply_support_case_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.public_tracking_review_request_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.public_tracking_create_request_v1(JSONB) FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA api TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.public_tracking_shipment_snapshot_v1(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_emit_support_message_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_enqueue_recipient_notification_v1(UUID, UUID, UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_create_reviewer_task_v1(UUID, UUID, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_assert_reviewer_v1() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shipment_apply_destination_address_change_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_apply_support_case_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_submit_request_v2(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_review_request_v1(JSONB) TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION api.public_tracking_submit_request_v2(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.public_tracking_apply_support_case_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.public_tracking_review_request_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.public_tracking_create_request_v1(JSONB) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.public_tracking_submit_request_v2(JSONB) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.public_tracking_apply_support_case_v1(JSONB) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.public_tracking_create_request_v1(JSONB) TO edge_api_gateway_role;
  END IF;
END $$;

-------------------------------------------------------------------------------
-- 8) task_type_catalog, ui_read_registry, and ui_navigation updates
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_task_types JSONB := '[]'::jsonb;
  v_resources JSONB := '[]'::jsonb;
  v_sections JSONB := '[]'::jsonb;
  v_source_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_has_operations BOOLEAN := FALSE;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NOT NULL THEN
    v_task_types := COALESCE(v_current->'task_types', '[]'::jsonb);
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_task_types) AS item
      WHERE item->>'key' = 'customer_shipment_change_review'
    ) THEN
      v_task_types := v_task_types || jsonb_build_array(
        jsonb_build_object(
          'key', 'customer_shipment_change_review',
          'name', 'Customer Shipment Change Review',
          'description', 'Review and apply customer-requested shipment location/date changes from public tracking.',
          'default_priority', 40,
          'default_queue_key', 'public_tracking',
          'enabled', TRUE
        )
      );
      v_current := jsonb_set(v_current, '{task_types}', v_task_types, TRUE);

      WITH current AS (
        SELECT s.settings_version_id,
               sv.version,
               sv.value
        FROM public.settings s
        JOIN public.settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'task_type_catalog'
          AND s.scope_type = 'global'
          AND s.scope_id IS NULL
        LIMIT 1
      ),
      applied AS (
        UPDATE public.settings_versions sv
        SET value = v_current,
            version = current.version + 1,
            change_reason = 'Add customer_shipment_change_review to task_type_catalog',
            approved_at = workflow_now(),
            effective_from = workflow_now()
        FROM current
        WHERE sv.id = current.settings_version_id
          AND v_current IS DISTINCT FROM current.value
        RETURNING sv.id, sv.value
      )
      UPDATE public.settings s
      SET cached_value = applied.value,
          last_updated = workflow_now()
      FROM applied
      WHERE s.category = 'task_type_catalog'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
        AND s.settings_version_id = applied.id;
    END IF;
  END IF;

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

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_resources) AS item
    WHERE item->>'key' = 'support_cases'
  ) THEN
    SELECT jsonb_agg(
      CASE
        WHEN item->>'key' = 'support_cases' THEN
          public.deep_merge_jsonb(
            item,
            jsonb_build_object(
              'select', jsonb_build_array(
                'id','organization_id','client_id','sender_id','resource_type','resource_id',
                'status','status_reason','priority','assigned_to','assigned_at','sla_minutes',
                'sla_due_at','opened_at','resolved_at','closed_at','request_source','request_type_key',
                'request_outcome','requester_channel','tracking_number','shipment_status_snapshot',
                'change_summary','changed_fields','metadata','created_at','updated_at'
              )
            )
          )
        ELSE item
      END
    )
    INTO v_resources
    FROM jsonb_array_elements(v_resources) AS item;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_resources) AS item
    WHERE item->>'key' = 'customer_shipment_changes'
  ) THEN
    v_resources := v_resources || jsonb_build_array(
      jsonb_build_object(
        'key', 'customer_shipment_changes',
        'label', 'Customer shipment changes',
        'relation', 'public.support_cases',
        'id_column', 'id',
        'scope_columns', jsonb_build_object('tenant','organization_id','client','client_id','sender','sender_id'),
        'capability_read', 'shipments.read',
        'capability_write', 'manual_review.resolve',
        'select', jsonb_build_array(
          'id','organization_id','client_id','sender_id','resource_type','resource_id',
          'status','status_reason','priority','assigned_to','assigned_at','sla_minutes',
          'sla_due_at','opened_at','resolved_at','closed_at','request_source','request_type_key',
          'request_outcome','requester_channel','tracking_number','shipment_status_snapshot',
          'change_summary','changed_fields','metadata','created_at','updated_at'
        ),
        'filters', jsonb_build_array(
          jsonb_build_object('key','status','column','status','op','eq'),
          jsonb_build_object('key','request_outcome','column','request_outcome','op','eq'),
          jsonb_build_object('key','request_type_key','column','request_type_key','op','eq'),
          jsonb_build_object('key','tracking_number','column','tracking_number','op','ilike'),
          jsonb_build_object('key','request_source','column','request_source','op','eq')
        ),
        'related', jsonb_build_array(
          jsonb_build_object('resource','support_messages','label','Messages','filter_key','support_case_id','from','id','limit',25),
          jsonb_build_object('resource','support_case_events','label','Events','filter_key','support_case_id','from','id','limit',50),
          jsonb_build_object('resource','shipment_actions','label','Shipment actions','filter_key','shipment_id','from','resource_id','limit',25)
        ),
        'default_sort', jsonb_build_object('column','created_at','direction','desc')
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

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
        change_reason = 'Add customer shipment changes resource and extend support_cases registry for review/detail.',
        approved_at = workflow_now(),
        effective_from = workflow_now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = workflow_now()
  FROM applied
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;

  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  v_source_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
    IF v_section->>'id' = 'operations' THEN
      v_has_operations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = 'console-customer-shipment-changes'
      ) THEN
        v_items := v_items || jsonb_build_array(
          jsonb_build_object(
            'id', 'console-customer-shipment-changes',
            'label', 'Customer shipment changes',
            'href', '/console/operations/customer-shipment-changes',
            'resource', 'customer_shipment_changes',
            'capability', 'shipments.read'
          )
        );
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = 'console-public-tracking-requests'
      ) THEN
        v_items := v_items || jsonb_build_array(
          jsonb_build_object(
            'id', 'console-public-tracking-requests',
            'label', 'Public tracking review queue',
            'href', '/console/operations/public-tracking-requests',
            'resource', 'customer_shipment_changes',
            'capability', 'shipments.read'
          )
        );
      END IF;

      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_operations IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'operations',
        'label', 'Operations',
        'items', jsonb_build_array(
          jsonb_build_object(
            'id', 'console-customer-shipment-changes',
            'label', 'Customer shipment changes',
            'href', '/console/operations/customer-shipment-changes',
            'resource', 'customer_shipment_changes',
            'capability', 'shipments.read'
          ),
          jsonb_build_object(
            'id', 'console-public-tracking-requests',
            'label', 'Public tracking review queue',
            'href', '/console/operations/public-tracking-requests',
            'resource', 'customer_shipment_changes',
            'capability', 'shipments.read'
          )
        )
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Add customer shipment changes routes to console ui_navigation',
        approved_at = workflow_now(),
        effective_from = workflow_now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = workflow_now()
  FROM applied
  WHERE s.category = 'ui_navigation'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603091130_public_tracking_customer_change_review_v1'));
COMMIT;
