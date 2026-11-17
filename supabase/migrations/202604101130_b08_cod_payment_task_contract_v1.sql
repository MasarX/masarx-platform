-- Plan: B08 Delivery proof & closeout / Step: E04
-- Migration: COD payment task contract v1
-- Purpose:
--   - Expose expected COD amount + accepted payment modes on visible route stops.
--   - Extend the canonical route-stop completion validator to normalize payment collection.
--   - Keep transition_task_v1 as the SSOT for normalized payment + partial-delivery task_event payloads.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101130_b08_cod_payment_task_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical payment outcome / method lookups + browser-safe stop terms helper
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'payment_collection_outcome',
    'Canonical route-stop COD payment outcomes recorded during delivery completion.',
    'dispatch',
    'tier_1',
    TRUE
  ),
  (
    'payment_collection_method',
    'Canonical route-stop COD payment collection methods exposed to Field Ops and settlement closeout.',
    'dispatch',
    'tier_1',
    TRUE
  )
ON CONFLICT (category) DO NOTHING;

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
JOIN (
  VALUES
    ('payment_collection_outcome', 'collected', 'Collected', 'The expected COD amount was collected at the stop.', 10, TRUE, '{}' ),
    ('payment_collection_outcome', 'refused', 'Refused', 'The customer refused payment at the stop.', 20, FALSE, '{}' ),
    ('payment_collection_method', 'cash', 'Cash', 'Cash collected at the doorstep.', 10, TRUE, '{}' ),
    ('payment_collection_method', 'card', 'Card', 'Card / POS collection at the doorstep.', 20, FALSE, '{}' ),
    ('payment_collection_method', 'bank_transfer', 'Bank transfer', 'Bank transfer or manual transfer confirmation.', 30, FALSE, '{}' ),
    ('payment_collection_method', 'wallet', 'Wallet', 'Digital wallet collection.', 40, FALSE, '{}' ),
    ('payment_collection_method', 'other', 'Other', 'Another policy-approved payment method.', 90, FALSE, '{}' )
) AS v(category, value, label, description, sort_order, is_default, metadata)
  ON v.category = ld.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.resolve_route_stop_payment_terms_v1(
  p_organization_id UUID,
  p_client_id UUID,
  p_sender_id UUID,
  p_branch_id UUID,
  p_cod_amount NUMERIC,
  p_cod_currency TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_ctx JSONB := '{}'::jsonb;
  v_cod_policy_row RECORD;
  v_allowed_methods JSONB := '[]'::jsonb;
  v_currency TEXT := NULLIF(btrim(COALESCE(p_cod_currency, '')), '');
  v_payment_mode_label TEXT := NULL;
BEGIN
  IF p_organization_id IS NULL OR COALESCE(p_cod_amount, 0) <= 0 THEN
    RETURN NULL;
  END IF;

  v_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', p_organization_id,
    'client_id', p_client_id,
    'sender_id', p_sender_id,
    'resource_id', p_branch_id
  ));

  SELECT *
    INTO v_cod_policy_row
    FROM public.resolve_cod_policy(v_ctx)
   LIMIT 1;

  IF FOUND AND jsonb_typeof(v_cod_policy_row.value) = 'object' THEN
    IF jsonb_typeof(v_cod_policy_row.value->'allowed_methods') = 'array' THEN
      SELECT COALESCE(jsonb_agg(lower(value) ORDER BY ordinality), '[]'::jsonb)
        INTO v_allowed_methods
        FROM jsonb_array_elements_text(v_cod_policy_row.value->'allowed_methods') WITH ORDINALITY AS methods(value, ordinality)
       WHERE NULLIF(btrim(COALESCE(value, '')), '') IS NOT NULL;
    END IF;

    v_currency := COALESCE(
      NULLIF(btrim(COALESCE(v_cod_policy_row.value->>'currency', '')), ''),
      v_currency
    );
  END IF;

  IF jsonb_typeof(v_allowed_methods) IS DISTINCT FROM 'array' OR jsonb_array_length(v_allowed_methods) = 0 THEN
    v_allowed_methods := '["cash"]'::jsonb;
  END IF;

  SELECT string_agg(
           COALESCE(lv.label, initcap(replace(methods.value, '_', ' '))),
           ' / '
           ORDER BY methods.ordinality
         )
    INTO v_payment_mode_label
    FROM jsonb_array_elements_text(v_allowed_methods) WITH ORDINALITY AS methods(value, ordinality)
    LEFT JOIN public.lookup_definitions ld
      ON ld.category = 'payment_collection_method'
    LEFT JOIN public.lookup_values lv
      ON lv.lookup_definition_id = ld.id
     AND lv.value = methods.value
     AND lv.status = 'active';

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'collection_required', TRUE,
    'expected_amount', p_cod_amount,
    'currency', COALESCE(v_currency, 'SAR'),
    'allowed_methods', v_allowed_methods,
    'payment_mode_label', v_payment_mode_label
  ));
END;
$function$;

COMMENT ON FUNCTION public.resolve_route_stop_payment_terms_v1(UUID, UUID, UUID, UUID, NUMERIC, TEXT)
  IS 'Browser-safe helper that resolves COD stop payment terms from canonical cod_policy without exposing policy internals.';

REVOKE ALL ON FUNCTION public.resolve_route_stop_payment_terms_v1(UUID, UUID, UUID, UUID, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_route_stop_payment_terms_v1(UUID, UUID, UUID, UUID, NUMERIC, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_route_stop_payment_terms_v1(UUID, UUID, UUID, UUID, NUMERIC, TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 2) Route stop visible surface + tasks.complete schema wiring
-------------------------------------------------------------------------------

DROP VIEW IF EXISTS api.route_stops;
DROP VIEW IF EXISTS public.route_stops_visible_v1;

CREATE VIEW public.route_stops_visible_v1
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
  s.cod_amount,
  s.cod_currency,
  payment_terms.payment AS payment,
  CASE
    WHEN COALESCE(payment_terms.payment->>'expected_amount', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (payment_terms.payment->>'expected_amount')::numeric
    ELSE NULL
  END AS expected_amount,
  CASE lower(COALESCE(payment_terms.payment->>'collection_required', ''))
    WHEN 'true' THEN TRUE
    WHEN 'false' THEN FALSE
    ELSE NULL
  END AS collection_required,
  COALESCE(payment_terms.payment->'allowed_methods', '[]'::jsonb) AS allowed_methods,
  NULLIF(btrim(COALESCE(payment_terms.payment->>'payment_mode_label', '')), '') AS payment_mode_label
FROM public.route_stops rs
JOIN public.route_runs rr
  ON rr.id = rs.route_run_id
LEFT JOIN public.shipments s
  ON s.id = rs.shipment_id
 AND s.organization_id = rs.organization_id
LEFT JOIN LATERAL (
  SELECT public.resolve_route_stop_payment_terms_v1(
    rs.organization_id,
    rs.client_id,
    s.sender_id,
    rr.branch_id,
    s.cod_amount,
    s.cod_currency
  ) AS payment
) AS payment_terms ON TRUE
WHERE public.route_run_actor_can_read_v1(
  rs.organization_id,
  rs.route_run_id,
  rr.driver_user_id
);

COMMENT ON VIEW public.route_stops_visible_v1 IS
  'Browser-safe executor-scoped route_stop manifest projection including COD payment terms.';

REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM PUBLIC;
REVOKE ALL ON TABLE public.route_stops_visible_v1 FROM anon;
GRANT SELECT ON TABLE public.route_stops_visible_v1 TO authenticated, service_role;

CREATE OR REPLACE VIEW api.route_stops
WITH (security_invoker = true) AS
SELECT *
FROM public.route_stops_visible_v1;

COMMENT ON VIEW api.route_stops IS
  'Browser-safe executor-scoped route_stop manifest projection including COD payment terms.';

REVOKE ALL ON api.route_stops FROM PUBLIC;
REVOKE ALL ON api.route_stops FROM anon;
GRANT SELECT ON api.route_stops TO authenticated, service_role;

DO $do$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_select_fields JSONB := '[]'::jsonb;
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

  FOR v_resource IN
    SELECT value
      FROM jsonb_array_elements(v_resources) AS value
  LOOP
    IF v_resource->>'key' = 'route_stops' THEN
      v_select_fields := COALESCE(v_resource->'select_fields', '[]'::jsonb);
      IF NOT (v_select_fields ? 'cod_amount') THEN
        v_select_fields := v_select_fields || jsonb_build_array('cod_amount');
      END IF;
      IF NOT (v_select_fields ? 'cod_currency') THEN
        v_select_fields := v_select_fields || jsonb_build_array('cod_currency');
      END IF;
      IF NOT (v_select_fields ? 'payment') THEN
        v_select_fields := v_select_fields || jsonb_build_array('payment');
      END IF;
      IF NOT (v_select_fields ? 'expected_amount') THEN
        v_select_fields := v_select_fields || jsonb_build_array('expected_amount');
      END IF;
      IF NOT (v_select_fields ? 'collection_required') THEN
        v_select_fields := v_select_fields || jsonb_build_array('collection_required');
      END IF;
      IF NOT (v_select_fields ? 'allowed_methods') THEN
        v_select_fields := v_select_fields || jsonb_build_array('allowed_methods');
      END IF;
      IF NOT (v_select_fields ? 'payment_mode_label') THEN
        v_select_fields := v_select_fields || jsonb_build_array('payment_mode_label');
      END IF;

      v_resource := jsonb_set(v_resource, '{select_fields}', v_select_fields, TRUE);
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  WITH current AS (
    SELECT s.id AS settings_id, s.settings_version_id, sv.version, sv.value
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
           change_reason = 'Expose COD amount and payment mode on visible route stops',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value, current.settings_id
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.id = applied.settings_id;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_next := jsonb_set(
      v_current,
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
                    'description', 'Capture delivery handover, COD collection when required, and partial-delivery details. Proof photos are collected by the mobile shell.',
                    'fields', jsonb_build_array(
                      jsonb_build_object('key', 'completion_kind', 'label', 'Completion kind', 'type', 'lookup', 'lookup_category', 'delivery_completion_kind', 'required', FALSE, 'default_value', 'full'),
                      jsonb_build_object('key', 'delivered_box_numbers', 'label', 'Delivered box numbers', 'type', 'text', 'required', FALSE, 'placeholder', 'For partial delivery only: enter delivered box numbers like 1,2'),
                      jsonb_build_object('key', 'payment_outcome', 'label', 'Payment outcome', 'type', 'lookup', 'lookup_category', 'payment_collection_outcome', 'required', FALSE, 'default_value', 'collected'),
                      jsonb_build_object('key', 'payment_method', 'label', 'Payment method', 'type', 'lookup', 'lookup_category', 'payment_collection_method', 'required', FALSE),
                      jsonb_build_object('key', 'payment_amount', 'label', 'Collected amount', 'type', 'number', 'required', FALSE, 'placeholder', 'Enter the amount collected from the customer'),
                      jsonb_build_object('key', 'payment_receipt_context', 'label', 'Receipt context', 'type', 'textarea', 'required', FALSE, 'placeholder', 'Receipt number, POS reference, or payment acknowledgement details.'),
                      jsonb_build_object('key', 'handover_mode', 'label', 'Handover mode', 'type', 'lookup', 'lookup_category', 'delivery_handover_mode', 'required', FALSE, 'default_value', 'named_recipient'),
                      jsonb_build_object('key', 'recipient_name', 'label', 'Recipient name', 'type', 'text', 'required', FALSE, 'placeholder', 'Who received the shipment?'),
                      jsonb_build_object('key', 'recipient_class', 'label', 'Recipient class', 'type', 'text', 'required', FALSE, 'placeholder', 'Concierge, front desk, mailroom, or similar.'),
                      jsonb_build_object('key', 'completion_notes', 'label', 'Completion notes', 'type', 'textarea', 'required', FALSE, 'placeholder', 'Add handoff notes, locker details, or drop-off context.')
                    )
                  ),
                  TRUE
                )
              ELSE item
            END
          )
          FROM jsonb_array_elements(COALESCE(v_current->'commands', '[]'::jsonb)) AS item
        ),
        '[]'::jsonb
      ),
      TRUE
    );

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose COD payment collection fields on tasks.complete schema',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

-------------------------------------------------------------------------------
-- 3) Canonical route-stop completion validator + normalized task transition payload
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_route_stop_completion_payload_v1(
  p_route_stop_id UUID,
  p_completion_reason TEXT DEFAULT NULL,
  p_task_event_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_stop public.route_stops%ROWTYPE;
  v_ship public.shipments%ROWTYPE;
  v_branch_id UUID := NULL;
  v_completion_reason TEXT := lower(NULLIF(btrim(COALESCE(p_completion_reason, '')), ''));
  v_completion_kind TEXT := NULL;
  v_box_source JSONB := '[]'::jsonb;
  v_box_number_source JSONB := '[]'::jsonb;
  v_box_id_text TEXT;
  v_box_number_text TEXT;
  v_uuid UUID;
  v_box_number INT;
  v_exception_meta JSONB := NULL;
  v_shipment_box_ids UUID[] := NULL;
  v_delivered_box_ids UUID[] := ARRAY[]::UUID[];
  v_delivered_box_numbers INT[] := ARRAY[]::INT[];
  v_total_box_count INT := 0;
  v_delivered_box_count INT := 0;
  v_payment_terms JSONB := NULL;
  v_payment_source JSONB := '{}'::jsonb;
  v_payment_outcome TEXT := NULL;
  v_payment_method TEXT := NULL;
  v_payment_receipt_context TEXT := NULL;
  v_payment_proof_artifact_ids JSONB := '[]'::jsonb;
  v_payment_signature_artifact_id UUID := NULL;
  v_expected_amount NUMERIC := NULL;
  v_collected_amount NUMERIC := NULL;
  v_variance_amount NUMERIC := NULL;
  v_currency TEXT := NULL;
  v_discrepancy_kind TEXT := NULL;
BEGIN
  IF p_route_stop_id IS NULL THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop_id is required' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(p_task_event_payload) IS DISTINCT FROM 'object' THEN
    p_task_event_payload := '{}'::jsonb;
  END IF;

  SELECT *
    INTO v_stop
    FROM public.route_stops
   WHERE id = p_route_stop_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_stop_finalize: route_stop not found: %', p_route_stop_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
    INTO v_ship
    FROM public.shipments
   WHERE id = v_stop.shipment_id
     AND organization_id = v_stop.organization_id
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_stop_finalize: shipment not found for route_stop %', p_route_stop_id
      USING ERRCODE = '23503';
  END IF;

  SELECT rr.branch_id
    INTO v_branch_id
    FROM public.route_runs rr
   WHERE rr.id = v_stop.route_run_id
   LIMIT 1;

  v_completion_kind := lower(NULLIF(btrim(COALESCE(
    NULLIF(p_task_event_payload->'delivery_completion'->>'completion_kind', ''),
    NULLIF(p_task_event_payload->'pod'->>'completion_kind', ''),
    NULLIF(p_task_event_payload->>'completion_kind', ''),
    NULLIF(
      CASE
        WHEN v_completion_reason = 'partial_delivery' THEN 'partial'
        ELSE ''
      END,
      ''
    )
  )), ''));

  IF v_completion_kind IS NULL THEN
    SELECT lv.metadata
      INTO v_exception_meta
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'dispatch_exception_reason'
       AND lv.value = v_completion_reason
       AND lv.status = 'active'
     LIMIT 1;

    IF jsonb_typeof(v_exception_meta) = 'object' THEN
      v_completion_kind := lower(NULLIF(btrim(COALESCE(v_exception_meta->>'delivery_progress_kind', '')), ''));
    END IF;
  END IF;

  v_completion_kind := COALESCE(v_completion_kind, 'full');

  IF v_completion_kind = 'partial' THEN
    v_box_source := COALESCE(
      p_task_event_payload->'delivered_box_ids',
      p_task_event_payload->'box_ids',
      p_task_event_payload->'pod'->'delivered_box_ids',
      p_task_event_payload->'pod'->'box_ids',
      '[]'::jsonb
    );
    v_box_number_source := COALESCE(
      p_task_event_payload->'delivery_completion'->'delivered_box_numbers',
      p_task_event_payload->'delivered_box_numbers',
      p_task_event_payload->'pod'->'delivered_box_numbers',
      '[]'::jsonb
    );
  END IF;

  IF jsonb_typeof(v_box_source) <> 'array' THEN
    v_box_source := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_box_number_source) NOT IN ('array', 'string') THEN
    v_box_number_source := '[]'::jsonb;
  END IF;

  IF v_completion_kind = 'partial' THEN
    PERFORM public.ensure_shipment_boxes(v_ship.id, COALESCE(NULLIF(v_ship.box_count, 0), 1));

    SELECT array_agg(sb.id ORDER BY sb.box_number)
      INTO v_shipment_box_ids
      FROM public.shipment_boxes sb
     WHERE sb.shipment_id = v_ship.id;

    v_total_box_count := COALESCE(array_length(v_shipment_box_ids, 1), 0);

    FOR v_box_id_text IN
      SELECT value
        FROM jsonb_array_elements_text(v_box_source) AS box_ids(value)
    LOOP
      BEGIN
        v_uuid := NULLIF(btrim(COALESCE(v_box_id_text, '')), '')::uuid;
      EXCEPTION
        WHEN others THEN
          v_uuid := NULL;
      END;

      IF v_uuid IS NOT NULL THEN
        v_delivered_box_ids := array_append(v_delivered_box_ids, v_uuid);
      END IF;
    END LOOP;

    IF array_length(v_delivered_box_ids, 1) IS NOT NULL THEN
      SELECT array_agg(DISTINCT x)
        INTO v_delivered_box_ids
        FROM unnest(v_delivered_box_ids) AS x;
    ELSE
      v_delivered_box_ids := NULL;
    END IF;

    IF jsonb_typeof(v_box_number_source) = 'array' THEN
      FOR v_box_number_text IN
        SELECT value
          FROM jsonb_array_elements_text(v_box_number_source) AS box_numbers(value)
      LOOP
        BEGIN
          v_box_number := NULLIF(btrim(COALESCE(v_box_number_text, '')), '')::INT;
        EXCEPTION
          WHEN others THEN
            v_box_number := NULL;
        END;

        IF v_box_number IS NULL OR v_box_number <= 0 THEN
          RAISE EXCEPTION 'route_stop_finalize: delivered_box_numbers must contain positive integers' USING ERRCODE = '23514';
        END IF;

        IF NOT (v_box_number = ANY (v_delivered_box_numbers)) THEN
          v_delivered_box_numbers := array_append(v_delivered_box_numbers, v_box_number);
        END IF;
      END LOOP;
    ELSIF jsonb_typeof(v_box_number_source) = 'string' THEN
      FOR v_box_number_text IN
        SELECT token
          FROM regexp_split_to_table(COALESCE(v_box_number_source #>> '{}', ''), '[,\s]+') AS token
         WHERE NULLIF(btrim(token), '') IS NOT NULL
      LOOP
        BEGIN
          v_box_number := NULLIF(btrim(COALESCE(v_box_number_text, '')), '')::INT;
        EXCEPTION
          WHEN others THEN
            v_box_number := NULL;
        END;

        IF v_box_number IS NULL OR v_box_number <= 0 THEN
          RAISE EXCEPTION 'route_stop_finalize: delivered_box_numbers must contain positive integers' USING ERRCODE = '23514';
        END IF;

        IF NOT (v_box_number = ANY (v_delivered_box_numbers)) THEN
          v_delivered_box_numbers := array_append(v_delivered_box_numbers, v_box_number);
        END IF;
      END LOOP;
    END IF;

    IF array_length(v_delivered_box_numbers, 1) IS NULL THEN
      v_delivered_box_numbers := NULL;
    END IF;

    IF array_length(v_delivered_box_ids, 1) IS NULL AND array_length(v_delivered_box_numbers, 1) IS NOT NULL THEN
      SELECT array_agg(sb.id ORDER BY sb.box_number)
        INTO v_delivered_box_ids
        FROM public.shipment_boxes sb
       WHERE sb.shipment_id = v_ship.id
         AND sb.box_number = ANY (v_delivered_box_numbers);

      IF COALESCE(array_length(v_delivered_box_ids, 1), 0) <> array_length(v_delivered_box_numbers, 1) THEN
        RAISE EXCEPTION 'route_stop_finalize: delivered_box_numbers must belong to shipment %', v_ship.id
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF array_length(v_delivered_box_ids, 1) IS NULL THEN
      RAISE EXCEPTION 'route_stop_finalize: partial_delivery requires delivered_box_ids or delivered_box_numbers'
        USING ERRCODE = '23514';
    END IF;

    v_delivered_box_count := array_length(v_delivered_box_ids, 1);
    IF v_total_box_count < 2 OR v_delivered_box_count >= v_total_box_count THEN
      RAISE EXCEPTION 'route_stop_finalize: partial_delivery requires a strict subset of shipment boxes (shipment box_count=% delivered=%)',
        v_total_box_count,
        v_delivered_box_count
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_payment_terms := public.resolve_route_stop_payment_terms_v1(
    v_stop.organization_id,
    v_stop.client_id,
    v_ship.sender_id,
    v_branch_id,
    v_ship.cod_amount,
    v_ship.cod_currency
  );

  IF jsonb_typeof(p_task_event_payload->'payment_collection') = 'object' THEN
    v_payment_source := p_task_event_payload->'payment_collection';
  ELSIF jsonb_typeof(p_task_event_payload #> '{delivery_completion,payment_collection}') = 'object' THEN
    v_payment_source := p_task_event_payload #> '{delivery_completion,payment_collection}';
  END IF;

  v_payment_outcome := lower(NULLIF(btrim(COALESCE(
    v_payment_source->>'outcome',
    p_task_event_payload->>'payment_outcome',
    ''
  )), ''));
  v_payment_method := lower(NULLIF(btrim(COALESCE(
    v_payment_source->>'method',
    p_task_event_payload->>'payment_method',
    ''
  )), ''));
  v_payment_receipt_context := NULLIF(btrim(COALESCE(
    v_payment_source->>'receipt_context',
    p_task_event_payload->>'payment_receipt_context',
    ''
  )), '');

  BEGIN
    v_collected_amount := NULLIF(btrim(COALESCE(
      v_payment_source->>'collected_amount',
      p_task_event_payload->>'payment_amount',
      ''
    )), '')::numeric;
  EXCEPTION
    WHEN others THEN
      v_collected_amount := NULL;
  END;

  IF jsonb_typeof(v_payment_source->'proof_artifact_ids') = 'array' THEN
    v_payment_proof_artifact_ids := v_payment_source->'proof_artifact_ids';
  ELSIF jsonb_typeof(p_task_event_payload->'artifact_ids') = 'array' THEN
    v_payment_proof_artifact_ids := p_task_event_payload->'artifact_ids';
  END IF;

  BEGIN
    v_payment_signature_artifact_id := NULLIF(btrim(COALESCE(
      v_payment_source->>'signature_artifact_id',
      p_task_event_payload->>'signature_artifact_id',
      ''
    )), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_payment_signature_artifact_id := NULL;
  END;

  IF v_payment_terms IS NULL THEN
    IF v_payment_source <> '{}'::jsonb
       OR v_payment_outcome IS NOT NULL
       OR v_payment_method IS NOT NULL
       OR v_collected_amount IS NOT NULL
       OR v_payment_receipt_context IS NOT NULL
    THEN
      RAISE EXCEPTION 'route_stop_finalize: payment_collection is only allowed for COD stops'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    v_payment_outcome := COALESCE(v_payment_outcome, 'collected');
    v_currency := COALESCE(
      NULLIF(btrim(COALESCE(v_payment_terms->>'currency', '')), ''),
      NULLIF(btrim(COALESCE(v_ship.cod_currency, '')), ''),
      'SAR'
    );

    BEGIN
      v_expected_amount := NULLIF(btrim(COALESCE(v_payment_terms->>'expected_amount', '')), '')::numeric;
    EXCEPTION
      WHEN others THEN
        v_expected_amount := NULL;
    END;
    v_expected_amount := COALESCE(v_expected_amount, v_ship.cod_amount);

    IF v_payment_outcome NOT IN ('collected', 'refused') THEN
      RAISE EXCEPTION 'route_stop_finalize: unsupported payment outcome %', v_payment_outcome
        USING ERRCODE = '23514';
    END IF;

    IF v_payment_outcome = 'collected' THEN
      IF v_payment_method IS NULL THEN
        RAISE EXCEPTION 'route_stop_finalize: payment_method is required when COD is collected'
          USING ERRCODE = '23514';
      END IF;

      IF jsonb_typeof(v_payment_terms->'allowed_methods') <> 'array'
         OR NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_payment_terms->'allowed_methods') AS methods(value)
            WHERE lower(methods.value) = v_payment_method
         )
      THEN
        RAISE EXCEPTION 'route_stop_finalize: payment_method % is not allowed for this COD stop', v_payment_method
          USING ERRCODE = '23514';
      END IF;

      IF v_collected_amount IS NULL OR v_collected_amount <= 0 THEN
        RAISE EXCEPTION 'route_stop_finalize: payment_amount must be greater than zero when COD is collected'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      v_payment_method := NULL;
      v_collected_amount := 0;
    END IF;

    v_variance_amount := COALESCE(v_expected_amount, 0) - COALESCE(v_collected_amount, 0);
    v_discrepancy_kind := CASE
      WHEN v_payment_outcome = 'refused' THEN 'refused'
      WHEN v_variance_amount > 0 THEN 'shortfall'
      WHEN v_variance_amount < 0 THEN 'over_collection'
      ELSE 'matched'
    END;

    v_payment_source := jsonb_strip_nulls(jsonb_build_object(
      'required', TRUE,
      'outcome', v_payment_outcome,
      'method', v_payment_method,
      'expected_amount', v_expected_amount,
      'collected_amount', v_collected_amount,
      'variance_amount', v_variance_amount,
      'has_discrepancy', (v_payment_outcome = 'refused' OR COALESCE(v_variance_amount, 0) <> 0),
      'discrepancy_kind', v_discrepancy_kind,
      'currency', v_currency,
      'allowed_methods', v_payment_terms->'allowed_methods',
      'payment_mode_label', v_payment_terms->>'payment_mode_label',
      'receipt_context', v_payment_receipt_context,
      'proof_artifact_ids', v_payment_proof_artifact_ids,
      'proof_artifact_count', CASE
        WHEN jsonb_typeof(v_payment_proof_artifact_ids) = 'array' THEN jsonb_array_length(v_payment_proof_artifact_ids)
        ELSE NULL
      END,
      'signature_artifact_id', v_payment_signature_artifact_id
    ));
  END IF;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'completion_kind', v_completion_kind,
      'delivered_box_ids', to_jsonb(v_delivered_box_ids),
      'delivered_box_numbers', to_jsonb(v_delivered_box_numbers),
      'delivered_box_count', v_delivered_box_count,
      'total_box_count', v_total_box_count,
      'remaining_box_count', CASE
        WHEN v_completion_kind = 'partial' THEN GREATEST(v_total_box_count - v_delivered_box_count, 0)
        ELSE NULL
      END,
      'payment_collection', CASE
        WHEN v_payment_terms IS NULL THEN NULL
        ELSE v_payment_source
      END
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.assert_route_stop_completion_payload_v1(UUID, TEXT, JSONB)
  IS 'Validates route-stop completion payloads at the task-transition boundary, rejecting invalid partial-delivery and COD payment collection input while returning canonical normalized payload fragments.';

CREATE OR REPLACE FUNCTION public.transition_task_v1(
  p_task_id UUID,
  p_to_status TEXT,
  p_status_reason TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID;
  v_is_platform BOOLEAN := public.is_platform_user();
  v_task public.tasks%ROWTYPE;
  v_task_type_key TEXT := NULL;
  v_branch_id UUID := NULL;

  v_org_id UUID;
  v_from_status TEXT;
  v_to_status TEXT := lower(COALESCE(NULLIF(p_to_status, ''), ''));
  v_status_reason TEXT := NULLIF(btrim(COALESCE(p_status_reason, '')), '');
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID;
  v_next_version INT;

  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_route_stop_completion JSONB := NULL;
  v_delivery_completion_patch JSONB := '{}'::jsonb;
  v_pod_patch JSONB := '{}'::jsonb;

  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_task_policy JSONB := '{}'::jsonb;
  v_required_session_type TEXT := NULL;
  v_required_on_statuses JSONB := '["completed"]'::jsonb;
  v_require_branch_match BOOLEAN := FALSE;
  v_requires_session BOOLEAN := FALSE;

  v_ops_session_id UUID := NULL;
  v_ops_session_org UUID := NULL;
  v_ops_session_actor UUID := NULL;
  v_ops_session_status TEXT := NULL;
  v_ops_session_type TEXT := NULL;
  v_ops_session_branch UUID := NULL;
  v_ops_session_is_final BOOLEAN := FALSE;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires an authenticated user';
  END IF;
  IF NOT v_is_platform AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
    RAISE EXCEPTION 'transition_task_v1 requires tenant/platform write scope' USING ERRCODE = '42501';
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires task_id';
  END IF;
  IF v_to_status = '' THEN
    RAISE EXCEPTION 'transition_task_v1 requires to_status';
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = p_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_task_v1 task not found: %', p_task_id;
  END IF;

  v_org_id := v_task.organization_id;
  IF NOT v_is_platform AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'transition_task_v1 task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_permission_v1('tasks.complete', v_org_id) THEN
    RAISE EXCEPTION 'transition_task_v1 requires tasks.complete permission' USING ERRCODE = '42501';
  END IF;

  IF v_idempotency IS NOT NULL THEN
    SELECT te.id INTO task_event_id
    FROM public.task_events te
    WHERE te.task_id = v_task.id
      AND te.idempotency_key = v_idempotency
    LIMIT 1;
    IF FOUND THEN
      task_id := v_task.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 task_type missing for task %', v_task.id
      USING ERRCODE = '23503';
  END IF;

  IF v_task.resource_type = 'settlement_batch' AND v_task.resource_id IS NOT NULL THEN
    SELECT sb.branch_id
      INTO v_branch_id
      FROM public.settlement_batches sb
     WHERE sb.id = v_task.resource_id
       AND sb.organization_id = v_org_id
     LIMIT 1;
  ELSIF v_task.resource_type = 'route_stop' AND v_task.resource_id IS NOT NULL THEN
    SELECT rr.branch_id
      INTO v_branch_id
      FROM public.route_stops rs
      JOIN public.route_runs rr
        ON rr.id = rs.route_run_id
     WHERE rs.id = v_task.resource_id
       AND rs.organization_id = v_org_id
       AND rr.organization_id = v_org_id
     LIMIT 1;
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_task.client_id,
    'sender_id', v_task.sender_id,
    'resource_id', v_branch_id
  ));

  SELECT * INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1('task_ops_session_policy', v_policy_ctx)
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  IF jsonb_typeof(v_policy) IS DISTINCT FROM 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;

  v_task_policy := COALESCE(v_policy #> ARRAY['task_type_map', v_task_type_key], '{}'::jsonb);
  IF jsonb_typeof(v_task_policy) IS DISTINCT FROM 'object' THEN
    v_task_policy := '{}'::jsonb;
  END IF;

  v_required_on_statuses := COALESCE(v_policy #> ARRAY['defaults', 'required_on_statuses'], v_required_on_statuses);
  BEGIN
    v_require_branch_match := COALESCE((v_policy #>> ARRAY['defaults', 'require_branch_match'])::boolean, v_require_branch_match);
  EXCEPTION WHEN others THEN
    v_require_branch_match := v_require_branch_match;
  END;

  v_required_session_type := NULLIF(btrim(COALESCE(v_task_policy->>'required_session_type', '')), '');
  v_required_on_statuses := COALESCE(v_task_policy->'required_on_statuses', v_required_on_statuses);
  BEGIN
    v_require_branch_match := COALESCE((v_task_policy->>'require_branch_match')::boolean, v_require_branch_match);
  EXCEPTION WHEN others THEN
    v_require_branch_match := v_require_branch_match;
  END;

  v_requires_session := (
    v_required_session_type IS NOT NULL
    AND COALESCE(
      jsonb_typeof(v_required_on_statuses) = 'array'
      AND v_to_status IN (SELECT jsonb_array_elements_text(v_required_on_statuses)),
      FALSE
    )
  );

  v_ops_session_id := COALESCE(
    NULLIF((v_payload->>'ops_session_id')::uuid, NULL),
    NULLIF((v_payload->>'session_id')::uuid, NULL),
    NULL
  );

  IF v_requires_session IS TRUE THEN
    IF v_ops_session_id IS NULL THEN
      RAISE EXCEPTION 'transition_task_v1 requires ops_session_id'
        USING ERRCODE = '23514',
              DETAIL = jsonb_build_object(
                'task_type_key', v_task_type_key,
                'required_session_type', v_required_session_type,
                'required_on_statuses', v_required_on_statuses,
                'require_branch_match', v_require_branch_match
              )::text;
    END IF;

    SELECT
      s.organization_id,
      s.actor_user_id,
      s.status,
      s.session_type,
      s.branch_id,
      (s.closed_at IS NOT NULL) AS is_final
    INTO
      v_ops_session_org,
      v_ops_session_actor,
      v_ops_session_status,
      v_ops_session_type,
      v_ops_session_branch,
      v_ops_session_is_final
    FROM public.ops_sessions s
    WHERE s.id = v_ops_session_id
    LIMIT 1;

    IF v_ops_session_org IS NULL THEN
      RAISE EXCEPTION 'transition_task_v1 invalid ops_session_id: %', v_ops_session_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_is_platform AND v_ops_session_org <> v_org_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session is outside current tenant scope' USING ERRCODE = '42501';
    END IF;

    IF NOT v_is_platform AND v_ops_session_actor IS DISTINCT FROM v_user_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session actor mismatch' USING ERRCODE = '42501';
    END IF;

    IF COALESCE(v_ops_session_is_final, FALSE) IS TRUE THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session is final' USING ERRCODE = '23514';
    END IF;

    IF v_required_session_type IS NOT NULL AND lower(COALESCE(v_ops_session_type, '')) IS DISTINCT FROM v_required_session_type THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session type mismatch (required %, got %)', v_required_session_type, v_ops_session_type
        USING ERRCODE = '23514';
    END IF;

    IF COALESCE(v_require_branch_match, FALSE) IS TRUE AND v_branch_id IS NOT NULL THEN
      IF v_ops_session_branch IS DISTINCT FROM v_branch_id THEN
        RAISE EXCEPTION 'transition_task_v1 ops_session branch mismatch (required %, got %)', v_branch_id, v_ops_session_branch
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  v_payload := (v_payload - 'ops_session_id' - 'session_id');

  IF v_to_status = 'completed'
     AND v_task_type_key = 'route_stop_execute'
     AND v_task.resource_type = 'route_stop'
     AND v_task.resource_id IS NOT NULL THEN
    v_route_stop_completion := public.assert_route_stop_completion_payload_v1(
      v_task.resource_id,
      v_status_reason,
      v_payload
    );

    IF COALESCE(v_route_stop_completion->>'completion_kind', '') = 'partial'
       AND v_status_reason IS NULL THEN
      v_status_reason := 'partial_delivery';
    END IF;

    v_payload := v_payload - 'payment_outcome' - 'payment_method' - 'payment_amount' - 'payment_receipt_context';

    IF v_route_stop_completion ? 'completion_kind' THEN
      v_payload := jsonb_set(v_payload, '{completion_kind}', v_route_stop_completion->'completion_kind', TRUE);
      v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('completion_kind', v_route_stop_completion->'completion_kind');
      v_pod_patch := v_pod_patch || jsonb_build_object('completion_kind', v_route_stop_completion->'completion_kind');
    END IF;
    IF v_route_stop_completion ? 'delivered_box_ids' THEN
      v_payload := jsonb_set(v_payload, '{delivered_box_ids}', v_route_stop_completion->'delivered_box_ids', TRUE);
      v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('delivered_box_ids', v_route_stop_completion->'delivered_box_ids');
      v_pod_patch := v_pod_patch || jsonb_build_object('delivered_box_ids', v_route_stop_completion->'delivered_box_ids');
    END IF;
    IF v_route_stop_completion ? 'delivered_box_numbers' THEN
      v_payload := jsonb_set(v_payload, '{delivered_box_numbers}', v_route_stop_completion->'delivered_box_numbers', TRUE);
      v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('delivered_box_numbers', v_route_stop_completion->'delivered_box_numbers');
      v_pod_patch := v_pod_patch || jsonb_build_object('delivered_box_numbers', v_route_stop_completion->'delivered_box_numbers');
    END IF;
    IF v_route_stop_completion ? 'delivered_box_count' THEN
      v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('delivered_box_count', v_route_stop_completion->'delivered_box_count');
    END IF;
    IF v_route_stop_completion ? 'total_box_count' THEN
      v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('total_box_count', v_route_stop_completion->'total_box_count');
    END IF;
    IF v_route_stop_completion ? 'remaining_box_count' THEN
      v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('remaining_box_count', v_route_stop_completion->'remaining_box_count');
    END IF;
    IF v_route_stop_completion ? 'payment_collection' THEN
      v_payload := jsonb_set(v_payload, '{payment_collection}', v_route_stop_completion->'payment_collection', TRUE);
      v_delivery_completion_patch := v_delivery_completion_patch || jsonb_build_object('payment_collection', v_route_stop_completion->'payment_collection');
    END IF;

    IF v_delivery_completion_patch <> '{}'::jsonb THEN
      v_payload := jsonb_set(
        v_payload,
        '{delivery_completion}',
        (
          CASE
            WHEN jsonb_typeof(v_payload->'delivery_completion') = 'object' THEN v_payload->'delivery_completion'
            ELSE '{}'::jsonb
          END
        ) || v_delivery_completion_patch,
        TRUE
      );
    END IF;

    IF v_pod_patch <> '{}'::jsonb THEN
      v_payload := jsonb_set(
        v_payload,
        '{pod}',
        (
          CASE
            WHEN jsonb_typeof(v_payload->'pod') = 'object' THEN v_payload->'pod'
            ELSE '{}'::jsonb
          END
        ) || v_pod_patch,
        TRUE
      );
    END IF;
  END IF;

  v_from_status := v_task.status;
  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET status = v_to_status,
         status_reason = v_status_reason,
         version = v_next_version,
         started_at = CASE WHEN started_at IS NULL THEN now() ELSE started_at END,
         completed_at = CASE WHEN v_to_status = 'completed' THEN now() ELSE completed_at END,
         canceled_at = CASE WHEN v_to_status = 'canceled' THEN now() ELSE canceled_at END
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'transition',
    p_decision_outcome := 'status_changed',
    p_performed_by_system := 'transition_task_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'from_status', v_from_status,
      'to_status', v_to_status,
      'status_reason', v_status_reason,
      'ops_session_id', v_ops_session_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.task_events (
    task_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    task_version,
    decision_log_id,
    settings_resolution_id,
    ops_session_id
  )
  VALUES (
    v_task.id,
    v_org_id,
    'status_changed',
    v_from_status,
    v_to_status,
    v_user_id,
    NULL,
    jsonb_strip_nulls(v_payload || jsonb_build_object(
      'status_reason', v_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL,
    v_ops_session_id
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT)
  IS 'Transition a task status (projection update + ledger event). Supports optional ops_session_id linkage, row-driven task_ops_session_policy, synchronous route-stop partial-delivery + COD payment payload validation, and canonical task_event normalization.';

SELECT pg_advisory_unlock(hashtext('202604101130_b08_cod_payment_task_contract_v1'));
COMMIT;
