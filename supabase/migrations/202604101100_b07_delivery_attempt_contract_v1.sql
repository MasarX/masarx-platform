-- Plan: Batch 7 field execution platform hardening / Step: E07
-- Migration: Delivery attempt contract, route-stop outcome visibility, and access-restricted evidence guard
-- Purpose:
-- - Close the Batch 7 delivery-attempt gap through the canonical write/read path.
-- - Keep failed-attempt semantics row-driven through lookup metadata and settings policy.
-- - Expose standardized attempt and route-stop outcome projections through shipment_actions,
--   api.route_stops, and the shipment timeline RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101100_b07_delivery_attempt_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup taxonomy alignment: access_restricted + standardized attempt semantics
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values AS lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  'access_restricted',
  'Access Restricted',
  'Driver could not gain access to the delivery location',
  95,
  FALSE,
  jsonb_build_object(
    'recommended_followup_task_type_key', 'dispatch_exception_review',
    'class', 'access'
  )
FROM public.lookup_definitions ld
WHERE ld.category = 'dispatch_exception_reason'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    metadata = COALESCE(lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  'partial_delivery',
  'Partial Delivery',
  'Delivery attempt completed only part of the shipment',
  5,
  FALSE,
  '{}'::jsonb
FROM public.lookup_definitions ld
WHERE ld.category = 'attempt_reason'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

DO $do$
DECLARE
  v_dispatch_def_id UUID := NULL;
BEGIN
  SELECT id
    INTO v_dispatch_def_id
    FROM public.lookup_definitions
   WHERE category = 'dispatch_exception_reason'
   LIMIT 1;

  IF v_dispatch_def_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_exception_reason lookup_definitions row missing';
  END IF;

  UPDATE public.lookup_values lv
     SET metadata = jsonb_strip_nulls(
           COALESCE(lv.metadata, '{}'::jsonb) ||
           jsonb_build_object(
             'default_shipment_status', COALESCE(
               lv.metadata->>'default_shipment_status',
               CASE lv.value
                 WHEN 'customer_refused' THEN 'return_to_origin'
                 WHEN 'package_damaged' THEN 'return_to_origin'
                 WHEN 'package_lost' THEN 'return_to_origin'
                 ELSE 'delivery_failed'
               END
             ),
             'default_action_type', COALESCE(lv.metadata->>'default_action_type', 'exception'),
             'default_action_category', COALESCE(lv.metadata->>'default_action_category', 'exception'),
             'attempt_reason', COALESCE(
               lv.metadata->>'attempt_reason',
               CASE lv.value
                 WHEN 'no_answer' THEN 'customer_not_available'
                 WHEN 'phone_unreachable' THEN 'customer_not_available'
                 WHEN 'business_closed' THEN 'customer_not_available'
                 WHEN 'customer_refused' THEN 'customer_refused'
                 WHEN 'address_not_found' THEN 'address_issue'
                 WHEN 'address_incorrect' THEN 'address_issue'
                 WHEN 'package_damaged' THEN 'damaged'
                 WHEN 'package_lost' THEN 'damaged'
                 WHEN 'access_restricted' THEN 'access_restricted'
                 ELSE 'other'
               END
             ),
             'default_ndr_action', COALESCE(
               lv.metadata->>'default_ndr_action',
               CASE lv.value
                 WHEN 'customer_refused' THEN 'return_to_sender'
                 WHEN 'package_damaged' THEN 'return_to_sender'
                 WHEN 'package_lost' THEN 'return_to_sender'
                 WHEN 'address_not_found' THEN 'reschedule'
                 WHEN 'address_incorrect' THEN 'reschedule'
                 ELSE 'reattempt'
               END
             ),
             'max_attempts', COALESCE(
               NULLIF(lv.metadata->>'max_attempts', '')::int,
               CASE lv.value
                 WHEN 'customer_refused' THEN 1
                 WHEN 'package_damaged' THEN 1
                 WHEN 'package_lost' THEN 1
                 WHEN 'address_not_found' THEN 2
                 WHEN 'address_incorrect' THEN 2
                 ELSE 3
               END
             )
           )
         ),
         updated_at = now()
   WHERE lv.lookup_definition_id = v_dispatch_def_id
     AND lv.value IN (
       'no_answer',
       'customer_refused',
       'address_not_found',
       'address_incorrect',
       'phone_unreachable',
       'payment_issue',
       'package_damaged',
       'package_lost',
       'business_closed',
       'access_restricted',
       'other'
     );
END;
$do$;

-------------------------------------------------------------------------------
-- 2) delivery_attempt_policy settings category + global default
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'delivery_attempt_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'default_max_attempts', jsonb_build_object('type', 'integer', 'minimum', 1),
      'default_eligible_ndr_action', jsonb_build_object('type', 'string'),
      'default_exhausted_ndr_action', jsonb_build_object('type', 'string'),
      'reason_overrides', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE
      )
    )
  ),
  'Policy that resolves standardized delivery-attempt count, eligibility, and NDR action defaults for route-stop shipment_actions.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'default_max_attempts', 3,
      'default_eligible_ndr_action', 'reattempt',
      'default_exhausted_ndr_action', 'return_to_sender',
      'reason_overrides', jsonb_build_object(
        'partial_delivery', jsonb_build_object('max_attempts', 3, 'eligible_ndr_action', 'reattempt'),
        'customer_not_available', jsonb_build_object('max_attempts', 3, 'eligible_ndr_action', 'reattempt'),
        'customer_refused', jsonb_build_object('max_attempts', 1, 'eligible_ndr_action', 'return_to_sender', 'force_ineligible', TRUE),
        'address_issue', jsonb_build_object('max_attempts', 2, 'eligible_ndr_action', 'reschedule'),
        'access_restricted', jsonb_build_object('max_attempts', 3, 'eligible_ndr_action', 'reattempt'),
        'damaged', jsonb_build_object('max_attempts', 1, 'eligible_ndr_action', 'return_to_sender', 'force_ineligible', TRUE),
        'other', jsonb_build_object('max_attempts', 2, 'eligible_ndr_action', 'reattempt')
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'delivery_attempt_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF jsonb_typeof(v_existing) = 'object' THEN
    RETURN;
  END IF;

  v_policy := jsonb_build_object(
    'version', 1,
    'default_max_attempts', 3,
    'default_eligible_ndr_action', 'reattempt',
    'default_exhausted_ndr_action', 'return_to_sender',
    'reason_overrides', jsonb_build_object(
      'partial_delivery', jsonb_build_object('max_attempts', 3, 'eligible_ndr_action', 'reattempt'),
      'customer_not_available', jsonb_build_object('max_attempts', 3, 'eligible_ndr_action', 'reattempt'),
      'customer_refused', jsonb_build_object('max_attempts', 1, 'eligible_ndr_action', 'return_to_sender', 'force_ineligible', TRUE),
      'address_issue', jsonb_build_object('max_attempts', 2, 'eligible_ndr_action', 'reschedule'),
      'access_restricted', jsonb_build_object('max_attempts', 3, 'eligible_ndr_action', 'reattempt'),
      'damaged', jsonb_build_object('max_attempts', 1, 'eligible_ndr_action', 'return_to_sender', 'force_ineligible', TRUE),
      'other', jsonb_build_object('max_attempts', 2, 'eligible_ndr_action', 'reattempt')
    )
  );

  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'delivery_attempt_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'delivery_attempt_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    'delivery_attempt_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Seed global delivery_attempt_policy',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  ) VALUES (
    'delivery_attempt_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

-------------------------------------------------------------------------------
-- 3) Canonical helpers and write-path triggers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_stop_attempt_outcome_from_action_v1(
  p_canonical_status TEXT,
  p_action_data JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN NULLIF(
      btrim(COALESCE(p_action_data #>> ARRAY['delivery_attempt', 'outcome'], '')),
      ''
    ) IS NOT NULL
      THEN lower(NULLIF(btrim(COALESCE(p_action_data #>> ARRAY['delivery_attempt', 'outcome'], '')), ''))
    WHEN lower(COALESCE(p_canonical_status, '')) = 'delivered'
      THEN 'delivered'
    WHEN lower(COALESCE(
           NULLIF(p_action_data #>> ARRAY['delivery_completion', 'completion_kind'], ''),
           NULLIF(p_action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'completion_kind'], ''),
           NULLIF(p_action_data #>> ARRAY['task_event_payload', 'pod', 'completion_kind'], ''),
           ''
         )) = 'partial'
      OR lower(COALESCE(p_action_data->>'outcome_reason', '')) = 'partial_delivery'
      THEN 'partial_delivery'
    WHEN NULLIF(btrim(COALESCE(p_action_data->>'route_stop_id', '')), '') IS NOT NULL
      THEN 'not_delivered'
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_delivery_attempt_projection_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_shipment_id UUID,
  p_route_stop_id UUID,
  p_canonical_status TEXT,
  p_action_type TEXT,
  p_action_data JSONB DEFAULT '{}'::jsonb,
  p_action_timestamp TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_action_data JSONB := COALESCE(p_action_data, '{}'::jsonb);
  v_stop_kind TEXT := NULL;
  v_branch_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_reason_overrides JSONB := '{}'::jsonb;
  v_reason_override JSONB := '{}'::jsonb;
  v_task_event_payload JSONB := '{}'::jsonb;
  v_exception_evidence JSONB := NULL;
  v_geostamp JSONB := NULL;
  v_dispatch_exception_reason TEXT := NULL;
  v_attempt_outcome TEXT := NULL;
  v_attempt_reason TEXT := NULL;
  v_ndr_action TEXT := NULL;
  v_route_stop_outcome TEXT := NULL;
  v_attempt_count INT := 0;
  v_max_attempts INT := 3;
  v_default_eligible_ndr_action TEXT := 'reattempt';
  v_default_exhausted_ndr_action TEXT := 'return_to_sender';
  v_eligible BOOLEAN := FALSE;
  v_force_ineligible BOOLEAN := FALSE;
  v_attempted_at TIMESTAMPTZ := COALESCE(p_action_timestamp, now());
  v_dispatch_meta JSONB := '{}'::jsonb;
  v_prior_attempt_count INT := 0;
  v_artifact_ids JSONB := '[]'::jsonb;
  v_artifact_count INT := 0;
BEGIN
  IF p_route_stop_id IS NULL OR p_shipment_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_action_data) IS DISTINCT FROM 'object' THEN
    v_action_data := '{}'::jsonb;
  END IF;

  SELECT
    lower(rs.stop_kind),
    rr.branch_id,
    s.sender_id
    INTO v_stop_kind, v_branch_id, v_sender_id
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
  JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  WHERE rs.id = p_route_stop_id
    AND rs.organization_id = p_organization_id
    AND rs.client_id = p_client_id
    AND rs.shipment_id = p_shipment_id
  LIMIT 1;

  IF v_stop_kind IS DISTINCT FROM 'delivery' THEN
    RETURN NULL;
  END IF;

  v_task_event_payload := COALESCE(v_action_data->'task_event_payload', '{}'::jsonb);
  IF jsonb_typeof(v_task_event_payload) IS DISTINCT FROM 'object' THEN
    v_task_event_payload := '{}'::jsonb;
  END IF;

  v_exception_evidence := COALESCE(v_task_event_payload->'exception_evidence', '{}'::jsonb);
  IF jsonb_typeof(v_exception_evidence) IS DISTINCT FROM 'object' THEN
    v_exception_evidence := NULL;
  END IF;

  v_dispatch_exception_reason := lower(
    NULLIF(
      btrim(
        COALESCE(
          v_action_data->>'outcome_reason',
          v_task_event_payload->>'exception_reason',
          v_task_event_payload->>'status_reason',
          ''
        )
      ),
      ''
    )
  );

  IF v_dispatch_exception_reason IS NOT NULL
     AND public.is_active_lookup_value_v1('dispatch_exception_reason', v_dispatch_exception_reason, TRUE) IS FALSE THEN
    v_dispatch_exception_reason := NULL;
  END IF;

  v_attempt_outcome := public.route_stop_attempt_outcome_from_action_v1(p_canonical_status, v_action_data);
  IF v_attempt_outcome IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_dispatch_exception_reason IS NOT NULL THEN
    SELECT COALESCE(lv.metadata, '{}'::jsonb)
      INTO v_dispatch_meta
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'dispatch_exception_reason'
       AND lv.value = v_dispatch_exception_reason
       AND lv.status = 'active'
     LIMIT 1;
  END IF;

  v_attempt_reason := CASE
    WHEN v_attempt_outcome = 'delivered' THEN NULL
    WHEN v_attempt_outcome = 'partial_delivery' THEN 'partial_delivery'
    WHEN v_dispatch_exception_reason IS NOT NULL THEN lower(NULLIF(btrim(COALESCE(v_dispatch_meta->>'attempt_reason', '')), ''))
    ELSE NULL
  END;

  IF v_attempt_reason IS NULL
     AND v_dispatch_exception_reason IS NOT NULL
     AND public.is_active_lookup_value_v1('attempt_reason', v_dispatch_exception_reason, TRUE) THEN
    v_attempt_reason := v_dispatch_exception_reason;
  END IF;

  IF v_attempt_reason IS NULL AND v_attempt_outcome <> 'delivered' THEN
    v_attempt_reason := 'other';
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'resource_id', v_branch_id,
    'organization_id', p_organization_id,
    'client_id', p_client_id,
    'sender_id', v_sender_id
  ));

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('delivery_attempt_policy', v_policy_ctx)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_policy) IS DISTINCT FROM 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  v_reason_overrides := COALESCE(v_policy->'reason_overrides', '{}'::jsonb);
  IF jsonb_typeof(v_reason_overrides) IS DISTINCT FROM 'object' THEN
    v_reason_overrides := '{}'::jsonb;
  END IF;

  v_reason_override := COALESCE(
    v_reason_overrides->COALESCE(v_attempt_reason, ''),
    '{}'::jsonb
  );
  IF jsonb_typeof(v_reason_override) IS DISTINCT FROM 'object' THEN
    v_reason_override := '{}'::jsonb;
  END IF;

  v_default_eligible_ndr_action := lower(
    COALESCE(
      NULLIF(v_policy->>'default_eligible_ndr_action', ''),
      'reattempt'
    )
  );
  v_default_exhausted_ndr_action := lower(
    COALESCE(
      NULLIF(v_policy->>'default_exhausted_ndr_action', ''),
      'return_to_sender'
    )
  );
  v_max_attempts := COALESCE(
    NULLIF(v_reason_override->>'max_attempts', '')::int,
    NULLIF(v_dispatch_meta->>'max_attempts', '')::int,
    NULLIF(v_policy->>'default_max_attempts', '')::int,
    3
  );
  v_force_ineligible := COALESCE((v_reason_override->>'force_ineligible')::boolean, FALSE);

  SELECT COUNT(*)::int
    INTO v_prior_attempt_count
    FROM public.shipment_actions sa
   WHERE sa.organization_id = p_organization_id
     AND sa.client_id = p_client_id
     AND sa.shipment_id = p_shipment_id
     AND NULLIF(btrim(COALESCE(sa.action_data->>'route_stop_id', '')), '') IS NOT NULL
     AND public.route_stop_attempt_outcome_from_action_v1(sa.canonical_status, sa.action_data) IS NOT NULL;

  v_attempt_count := v_prior_attempt_count + 1;

  IF v_attempt_outcome = 'delivered' THEN
    v_route_stop_outcome := 'completed';
    v_ndr_action := NULL;
    v_eligible := FALSE;
  ELSE
    v_route_stop_outcome := 'attempted';
    IF v_force_ineligible OR v_attempt_count >= GREATEST(v_max_attempts, 1) THEN
      v_ndr_action := lower(COALESCE(
        NULLIF(v_reason_override->>'exhausted_ndr_action', ''),
        NULLIF(v_dispatch_meta->>'default_ndr_action', ''),
        v_default_exhausted_ndr_action
      ));
      v_eligible := FALSE;
    ELSE
      v_ndr_action := lower(COALESCE(
        NULLIF(v_reason_override->>'eligible_ndr_action', ''),
        NULLIF(v_reason_override->>'ndr_action', ''),
        NULLIF(v_dispatch_meta->>'default_ndr_action', ''),
        v_default_eligible_ndr_action
      ));
      v_eligible := v_ndr_action IN ('reattempt', 'reschedule');
    END IF;
  END IF;

  BEGIN
    v_attempted_at := COALESCE(
      NULLIF(
        btrim(
          COALESCE(
            v_exception_evidence->>'captured_at',
            v_task_event_payload->>'captured_at',
            v_task_event_payload #>> '{pod,captured_at}',
            ''
          )
        ),
        ''
      )::timestamptz,
      v_attempted_at
    );
  EXCEPTION
    WHEN others THEN
      v_attempted_at := COALESCE(p_action_timestamp, now());
  END;

  v_geostamp := CASE
    WHEN jsonb_typeof(v_exception_evidence->'geostamp') = 'object' THEN v_exception_evidence->'geostamp'
    WHEN jsonb_typeof(v_task_event_payload->'geostamp') = 'object' THEN v_task_event_payload->'geostamp'
    WHEN jsonb_typeof(v_task_event_payload #> '{pod,geostamp}') = 'object' THEN v_task_event_payload #> '{pod,geostamp}'
    ELSE NULL
  END;

  v_artifact_ids := COALESCE(
    v_action_data->'artifact_ids',
    v_task_event_payload->'artifact_ids',
    '[]'::jsonb
  );
  IF jsonb_typeof(v_artifact_ids) IS DISTINCT FROM 'array' THEN
    v_artifact_ids := '[]'::jsonb;
  END IF;
  v_artifact_count := COALESCE(
    NULLIF(v_exception_evidence->>'proof_artifact_count', '')::int,
    jsonb_array_length(v_artifact_ids),
    0
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'outcome', v_attempt_outcome,
    'reason', v_attempt_reason,
    'dispatch_exception_reason', v_dispatch_exception_reason,
    'ndr_action', v_ndr_action,
    'attempt_count', v_attempt_count,
    'max_attempts', v_max_attempts,
    'eligible', v_eligible,
    'attempted_at', v_attempted_at,
    'proof_artifact_count', v_artifact_count,
    'artifact_ids', v_artifact_ids,
    'exception_evidence', v_exception_evidence,
    'geostamp', v_geostamp,
    'route_stop_outcome', v_route_stop_outcome
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_delivery_attempt_evidence_v1()
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
  v_exception_reason TEXT := NULL;
  v_has_notes BOOLEAN := FALSE;
  v_has_artifacts BOOLEAN := FALSE;
  v_has_geostamp BOOLEAN := FALSE;
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

  SELECT lower(rs.stop_kind)
    INTO v_stop_kind
  FROM public.route_stops rs
  WHERE rs.id = v_resource_id
    AND rs.organization_id = v_task_org
  LIMIT 1;

  IF v_stop_kind IS DISTINCT FROM 'delivery' THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  v_exception_reason := lower(NULLIF(
    btrim(COALESCE(v_payload->>'exception_reason', v_payload->>'status_reason', '')),
    ''
  ));

  IF v_exception_reason IS DISTINCT FROM 'access_restricted' THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  v_has_notes := NULLIF(
    btrim(
      COALESCE(
        v_payload->>'exception_notes',
        v_payload->>'completion_notes',
        ''
      )
    ),
    ''
  ) IS NOT NULL;

  v_has_artifacts := (
    COALESCE(
      CASE
        WHEN jsonb_typeof(v_payload->'artifact_ids') = 'array' THEN jsonb_array_length(v_payload->'artifact_ids')
        ELSE 0
      END,
      0
    ) > 0
    OR NULLIF(btrim(COALESCE(v_payload->>'signature_artifact_id', '')), '') IS NOT NULL
    OR COALESCE(NULLIF(v_payload #>> '{exception_evidence,proof_artifact_count}', '')::int, 0) > 0
  );

  v_has_geostamp := jsonb_typeof(v_payload #> '{exception_evidence,geostamp}') = 'object'
    OR jsonb_typeof(v_payload->'geostamp') = 'object'
    OR jsonb_typeof(v_payload #> '{pod,geostamp}') = 'object';

  IF NOT v_has_notes AND NOT v_has_artifacts AND NOT v_has_geostamp THEN
    RAISE EXCEPTION 'access_restricted delivery attempts require notes, proof artifacts, or a geostamp'
      USING ERRCODE = '23514';
  END IF;

  NEW.payload := v_payload;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.validate_delivery_attempt_evidence_v1()
  IS 'Before-insert task_events guard for access_restricted delivery attempts: require notes, proof artifacts, or geostamp evidence.';

DROP TRIGGER IF EXISTS trg_task_events_delivery_attempt_evidence ON public.task_events;
CREATE TRIGGER trg_task_events_delivery_attempt_evidence
  BEFORE INSERT ON public.task_events
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_delivery_attempt_evidence_v1();

CREATE OR REPLACE FUNCTION public.normalize_route_stop_delivery_attempt_action_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_action_data JSONB := COALESCE(NEW.action_data, '{}'::jsonb);
  v_route_stop_id UUID := NULL;
  v_delivery_attempt JSONB := NULL;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_action_data) IS DISTINCT FROM 'object' THEN
    v_action_data := '{}'::jsonb;
  END IF;

  BEGIN
    v_route_stop_id := NULLIF(btrim(COALESCE(v_action_data->>'route_stop_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;

  IF v_route_stop_id IS NULL THEN
    NEW.action_data := v_action_data;
    RETURN NEW;
  END IF;

  v_delivery_attempt := public.compute_delivery_attempt_projection_v1(
    p_organization_id := NEW.organization_id,
    p_client_id := NEW.client_id,
    p_shipment_id := NEW.shipment_id,
    p_route_stop_id := v_route_stop_id,
    p_canonical_status := NEW.canonical_status,
    p_action_type := NEW.action_type,
    p_action_data := v_action_data,
    p_action_timestamp := COALESCE(NEW.timestamp, now())
  );

  IF jsonb_typeof(v_delivery_attempt) = 'object' THEN
    v_action_data := jsonb_set(v_action_data, '{delivery_attempt}', v_delivery_attempt, TRUE);
    v_action_data := jsonb_set(
      v_action_data,
      '{route_stop_outcome}',
      to_jsonb(COALESCE(v_delivery_attempt->>'route_stop_outcome', 'attempted')),
      TRUE
    );
  END IF;

  NEW.action_data := v_action_data;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.normalize_route_stop_delivery_attempt_action_v1()
  IS 'Before-insert shipment_actions normalization for delivery route_stop actions: persist standardized delivery_attempt metadata and route_stop_outcome.';

DROP TRIGGER IF EXISTS trg_shipment_actions_delivery_attempt_contract ON public.shipment_actions;
CREATE TRIGGER trg_shipment_actions_delivery_attempt_contract
  BEFORE INSERT ON public.shipment_actions
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_route_stop_delivery_attempt_action_v1();

-------------------------------------------------------------------------------
-- 4) shipment_actions attempt projections
-------------------------------------------------------------------------------

ALTER TABLE public.shipment_actions
  ADD COLUMN IF NOT EXISTS delivery_attempt_outcome TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'outcome'], '')),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS delivery_attempt_reason TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'reason'], '')),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS dispatch_exception_reason TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_attempt', 'dispatch_exception_reason'],
            action_data->>'outcome_reason',
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS delivery_attempt_ndr_action TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'ndr_action'], '')),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS delivery_attempt_count INTEGER
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'attempt_count'], '')),
        ''
      )::integer
    ) STORED,
  ADD COLUMN IF NOT EXISTS delivery_attempt_eligible BOOLEAN
    GENERATED ALWAYS AS (
      CASE
        WHEN NULLIF(
          btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'eligible'], '')),
          ''
        ) IS NULL THEN NULL
        ELSE (action_data #>> ARRAY['delivery_attempt', 'eligible'])::boolean
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS delivery_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS route_stop_outcome TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data->>'route_stop_outcome',
            action_data #>> ARRAY['delivery_attempt', 'route_stop_outcome'],
            ''
          )
        ),
        ''
      )
    ) STORED;

COMMENT ON COLUMN public.shipment_actions.delivery_attempt_outcome IS
  'Generated standardized delivery-attempt outcome derived from action_data.delivery_attempt.';
COMMENT ON COLUMN public.shipment_actions.delivery_attempt_reason IS
  'Generated standardized delivery-attempt reason derived from action_data.delivery_attempt.';
COMMENT ON COLUMN public.shipment_actions.dispatch_exception_reason IS
  'Generated canonical dispatch exception reason derived from route-stop action_data.';
COMMENT ON COLUMN public.shipment_actions.delivery_attempt_ndr_action IS
  'Generated standardized NDR action derived from action_data.delivery_attempt.';
COMMENT ON COLUMN public.shipment_actions.delivery_attempt_count IS
  'Generated delivery-attempt count derived from action_data.delivery_attempt.';
COMMENT ON COLUMN public.shipment_actions.delivery_attempt_eligible IS
  'Generated reattempt eligibility derived from action_data.delivery_attempt.';
COMMENT ON COLUMN public.shipment_actions.delivery_attempted_at IS
  'Canonical failed-attempt timestamp synchronized from action_data.delivery_attempt.';
COMMENT ON COLUMN public.shipment_actions.route_stop_outcome IS
  'Generated route-stop execution outcome derived from action_data.route_stop_outcome.';

CREATE OR REPLACE FUNCTION public.sync_shipment_action_delivery_attempt_columns_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_attempted_at_raw TEXT := NULLIF(
    btrim(COALESCE(COALESCE(NEW.action_data, '{}'::jsonb) #>> ARRAY['delivery_attempt', 'attempted_at'], '')),
    ''
  );
BEGIN
  BEGIN
    NEW.delivery_attempted_at :=
      CASE
        WHEN v_attempted_at_raw IS NULL THEN NULL
        ELSE v_attempted_at_raw::timestamptz
      END;
  EXCEPTION
    WHEN others THEN
      NEW.delivery_attempted_at := NULL;
  END;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.sync_shipment_action_delivery_attempt_columns_v1()
  IS 'Before-write shipment_actions sync for canonical delivery_attempt scalar columns that cannot use immutable generated expressions.';

DROP TRIGGER IF EXISTS trg_shipment_actions_delivery_attempt_columns_sync ON public.shipment_actions;
CREATE TRIGGER trg_shipment_actions_delivery_attempt_columns_sync
  BEFORE INSERT OR UPDATE OF action_data ON public.shipment_actions
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_shipment_action_delivery_attempt_columns_v1();

UPDATE public.shipment_actions
   SET delivery_attempted_at =
     CASE
       WHEN NULLIF(
         btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'attempted_at'], '')),
         ''
       ) IS NULL THEN NULL
       ELSE NULLIF(
         btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'attempted_at'], '')),
         ''
       )::timestamptz
     END
 WHERE delivery_attempted_at IS DISTINCT FROM
       CASE
         WHEN NULLIF(
           btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'attempted_at'], '')),
           ''
         ) IS NULL THEN NULL
         ELSE NULLIF(
           btrim(COALESCE(action_data #>> ARRAY['delivery_attempt', 'attempted_at'], '')),
           ''
         )::timestamptz
       END;

CREATE INDEX IF NOT EXISTS idx_shipment_actions_delivery_attempt_outcome
  ON public.shipment_actions (delivery_attempt_outcome)
  WHERE delivery_attempt_outcome IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipment_actions_route_stop_outcome
  ON public.shipment_actions (route_stop_outcome)
  WHERE route_stop_outcome IS NOT NULL;

-------------------------------------------------------------------------------
-- 5) Route-stop manifest + shipment timeline read surfaces
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.route_stops_visible_v1
WITH (security_invoker = true) AS
SELECT
  rs.*,
  rr.status AS route_run_status,
  rr.driver_user_id,
  rr.vehicle_id,
  rr.branch_id,
  rr.route_plan_id,
  rr.planned_date,
  rr.planned_start_at AS route_planned_start_at,
  rr.planned_end_at AS route_planned_end_at,
  COALESCE(rr.metadata->'route_assignment', '{}'::jsonb) AS route_assignment,
  latest_action.id AS shipment_action_id,
  COALESCE(
    NULLIF(btrim(COALESCE(rs.metadata #>> ARRAY['execution', 'outcome'], '')), ''),
    latest_action.route_stop_outcome,
    CASE
      WHEN latest_action.id IS NOT NULL AND latest_action.delivery_attempt_outcome = 'delivered' THEN 'completed'
      WHEN latest_action.id IS NOT NULL THEN 'attempted'
      WHEN EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(rr.metadata #> '{route_closeout,remaining_stop_ids}') = 'array'
                     THEN rr.metadata #> '{route_closeout,remaining_stop_ids}'
                   ELSE '[]'::jsonb
                 END
               ) AS remaining(value)
         WHERE remaining.value = rs.id::text
      ) THEN 'skipped'
      ELSE 'untouched'
    END
  ) AS route_stop_outcome,
  latest_action.delivery_attempt_outcome,
  latest_action.delivery_attempt_reason,
  latest_action.dispatch_exception_reason,
  latest_action.delivery_attempt_ndr_action,
  latest_action.delivery_attempt_count,
  latest_action.delivery_attempt_eligible,
  latest_action.delivery_attempted_at
FROM public.route_stops rs
JOIN public.route_runs rr
  ON rr.id = rs.route_run_id
LEFT JOIN LATERAL (
  SELECT
    sa.id,
    sa.route_stop_outcome,
    sa.delivery_attempt_outcome,
    sa.delivery_attempt_reason,
    sa.dispatch_exception_reason,
    sa.delivery_attempt_ndr_action,
    sa.delivery_attempt_count,
    sa.delivery_attempt_eligible,
    sa.delivery_attempted_at,
    sa.canonical_status
  FROM public.shipment_actions sa
  WHERE sa.organization_id = rs.organization_id
    AND sa.client_id = rs.client_id
    AND sa.shipment_id = rs.shipment_id
    AND sa.action_data->>'route_stop_id' = rs.id::text
  ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
  LIMIT 1
) AS latest_action
  ON TRUE
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_stops_visible_v1 IS
  'Executor-safe route_stop manifest projection scoped to the visible route inventory, including standardized delivery-attempt and route-stop outcome metadata.';

REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM anon;
GRANT SELECT ON TABLE public.route_stops_visible_v1 TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection with standardized attempt and route-stop outcome metadata.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

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
          NULLIF(sa.delivery_attempt_reason, ''),
          NULLIF(sa.dispatch_exception_reason, ''),
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
          'notes', sa.notes,
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

-------------------------------------------------------------------------------
-- 6) UI registry wiring for shipment_actions + route_stops
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_select_fields JSONB := '[]'::jsonb;
  v_filters JSONB := '[]'::jsonb;
  v_found_shipment_actions BOOLEAN := FALSE;
  v_found_route_stops BOOLEAN := FALSE;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ui_read_registry resources must be an array';
  END IF;

  FOR v_resource IN
    SELECT value
      FROM jsonb_array_elements(v_resources) AS value
  LOOP
    IF v_resource->>'key' = 'shipment_actions' THEN
      v_found_shipment_actions := TRUE;
      v_select_fields := COALESCE(v_resource->'select_fields', '[]'::jsonb);
      IF jsonb_typeof(v_select_fields) IS DISTINCT FROM 'array' THEN
        v_select_fields := '[]'::jsonb;
      END IF;

      v_select_fields := v_select_fields
        || jsonb_build_array(
          'delivery_attempt_outcome',
          'delivery_attempt_reason',
          'dispatch_exception_reason',
          'delivery_attempt_ndr_action',
          'delivery_attempt_count',
          'delivery_attempt_eligible',
          'delivery_attempted_at',
          'route_stop_outcome'
        );

      SELECT COALESCE(jsonb_agg(DISTINCT to_jsonb(value)), '[]'::jsonb)
        INTO v_select_fields
        FROM jsonb_array_elements_text(v_select_fields) AS value;

      v_filters := COALESCE(v_resource->'filters', '[]'::jsonb);
      IF jsonb_typeof(v_filters) IS DISTINCT FROM 'array' THEN
        v_filters := '[]'::jsonb;
      END IF;

      v_filters := v_filters
        || jsonb_build_array(
          jsonb_build_object('key', 'delivery_attempt_outcome', 'column', 'delivery_attempt_outcome', 'op', 'eq'),
          jsonb_build_object('key', 'delivery_attempt_reason', 'column', 'delivery_attempt_reason', 'op', 'eq'),
          jsonb_build_object('key', 'dispatch_exception_reason', 'column', 'dispatch_exception_reason', 'op', 'eq'),
          jsonb_build_object('key', 'delivery_attempt_eligible', 'column', 'delivery_attempt_eligible', 'op', 'eq'),
          jsonb_build_object('key', 'route_stop_outcome', 'column', 'route_stop_outcome', 'op', 'eq')
        );

      v_resource := jsonb_set(v_resource, '{select_fields}', v_select_fields, TRUE);
      v_resource := jsonb_set(v_resource, '{filters}', v_filters, TRUE);
      v_resource := jsonb_set(
        v_resource,
        '{column_labels}',
        COALESCE(v_resource->'column_labels', '{}'::jsonb) || jsonb_build_object(
          'delivery_attempt_outcome', 'Attempt outcome',
          'delivery_attempt_reason', 'Attempt reason',
          'dispatch_exception_reason', 'Dispatch exception reason',
          'delivery_attempt_ndr_action', 'NDR action',
          'delivery_attempt_count', 'Attempt count',
          'delivery_attempt_eligible', 'Attempt eligible',
          'delivery_attempted_at', 'Attempted at',
          'route_stop_outcome', 'Route-stop outcome'
        ),
        TRUE
      );
    ELSIF v_resource->>'key' = 'route_stops' THEN
      v_found_route_stops := TRUE;
      v_select_fields := COALESCE(v_resource->'select_fields', '[]'::jsonb);
      IF jsonb_typeof(v_select_fields) IS DISTINCT FROM 'array' THEN
        v_select_fields := '[]'::jsonb;
      END IF;

      v_select_fields := v_select_fields
        || jsonb_build_array(
          'shipment_action_id',
          'route_stop_outcome',
          'delivery_attempt_outcome',
          'delivery_attempt_reason',
          'dispatch_exception_reason',
          'delivery_attempt_ndr_action',
          'delivery_attempt_count',
          'delivery_attempt_eligible',
          'delivery_attempted_at'
        );

      SELECT COALESCE(jsonb_agg(DISTINCT to_jsonb(value)), '[]'::jsonb)
        INTO v_select_fields
        FROM jsonb_array_elements_text(v_select_fields) AS value;

      v_filters := COALESCE(v_resource->'filters', '[]'::jsonb);
      IF jsonb_typeof(v_filters) IS DISTINCT FROM 'array' THEN
        v_filters := '[]'::jsonb;
      END IF;

      v_filters := v_filters
        || jsonb_build_array(
          jsonb_build_object('key', 'route_stop_outcome', 'column', 'route_stop_outcome', 'op', 'eq'),
          jsonb_build_object('key', 'delivery_attempt_outcome', 'column', 'delivery_attempt_outcome', 'op', 'eq'),
          jsonb_build_object('key', 'delivery_attempt_reason', 'column', 'delivery_attempt_reason', 'op', 'eq'),
          jsonb_build_object('key', 'dispatch_exception_reason', 'column', 'dispatch_exception_reason', 'op', 'eq'),
          jsonb_build_object('key', 'delivery_attempt_eligible', 'column', 'delivery_attempt_eligible', 'op', 'eq')
        );

      v_resource := jsonb_set(v_resource, '{select_fields}', v_select_fields, TRUE);
      v_resource := jsonb_set(v_resource, '{filters}', v_filters, TRUE);
      v_resource := jsonb_set(
        v_resource,
        '{column_labels}',
        COALESCE(v_resource->'column_labels', '{}'::jsonb) || jsonb_build_object(
          'shipment_action_id', 'Shipment action',
          'route_stop_outcome', 'Route-stop outcome',
          'delivery_attempt_outcome', 'Attempt outcome',
          'delivery_attempt_reason', 'Attempt reason',
          'dispatch_exception_reason', 'Dispatch exception reason',
          'delivery_attempt_ndr_action', 'NDR action',
          'delivery_attempt_count', 'Attempt count',
          'delivery_attempt_eligible', 'Attempt eligible',
          'delivery_attempted_at', 'Attempted at'
        ),
        TRUE
      );
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  IF v_found_shipment_actions IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_read_registry missing shipment_actions resource';
  END IF;
  IF v_found_route_stops IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_read_registry missing route_stops resource';
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Expose Batch 7 delivery-attempt projections on shipment_actions and route_stops UI reads',
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

SELECT pg_advisory_unlock(hashtext('202604101100_b07_delivery_attempt_contract_v1'));
COMMIT;
