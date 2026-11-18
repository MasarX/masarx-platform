-- Console V2 pickup failure retry policy and lookup coverage.
-- Failure follow-up rows are rendered from api.pickup_failures_list_v1 and
-- retried through create_pickup_wave_v1, so the backend policy/lookup catalog
-- must explicitly support failed pickup rows without frontend literals.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605211230_console_v2_pickup_failure_retry_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES
  (
    'pickup_failure_reason',
    'Pickup failure reason taxonomy (api.pickup_failures_list_v1 projection) consumed by operate/pickups.tsx failures tab.',
    'operations',
    'tier_1',
    false
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata
FROM public.lookup_definitions ld
JOIN (
  VALUES
    ('sender_not_ready', 'Sender not ready', 10, true, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('sender_unavailable', 'Sender unavailable', 11, false, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('pickup_not_ready', 'Pickup not ready', 12, false, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('business_closed', 'Business closed', 13, false, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('no_answer', 'No answer', 14, false, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('phone_unreachable', 'Phone unreachable', 15, false, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('address_invalid', 'Address invalid', 20, false, jsonb_build_object('tone', 'danger', 'retryable', false)),
    ('address_not_found', 'Address not found', 21, false, jsonb_build_object('tone', 'danger', 'retryable', false)),
    ('driver_unavailable', 'Driver unavailable', 30, false, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('vehicle_unavailable', 'Vehicle unavailable', 40, false, jsonb_build_object('tone', 'warn', 'retryable', true)),
    ('access_restricted', 'Access restricted', 50, false, jsonb_build_object('tone', 'danger', 'retryable', false)),
    ('quantity_mismatch', 'Quantity mismatch', 60, false, jsonb_build_object('tone', 'danger', 'retryable', false)),
    ('other', 'Other', 90, false, jsonb_build_object('tone', 'neutral', 'retryable', true))
) AS v(value, label, sort_order, is_default, metadata)
  ON ld.category = 'pickup_failure_reason'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    retired_at = NULL,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  'pickup_failed',
  'Pickup failed',
  51,
  false,
  'active',
  jsonb_build_object('tone', 'danger', 'lifecycle', 'failed', 'is_terminal', true)
FROM public.lookup_definitions ld
WHERE ld.category = 'pickup_request_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    retired_at = NULL,
    updated_at = now();

DO $do$
DECLARE
  v_row RECORD;
  v_allowed JSONB;
  v_next_version INT;
  v_next_value JSONB;
  v_sv_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'pickup_policy'
       AND s.scope_type = 'global'
       AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ) THEN
    v_allowed := COALESCE(public.pickup_policy_default_v1() #> '{wave,allowed_shipment_statuses}', '[]'::jsonb);

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(v_allowed) AS e(value)
       WHERE e.value = 'pickup_failed'
    ) THEN
      v_allowed := v_allowed || jsonb_build_array('pickup_failed');
    END IF;

    v_next_value := jsonb_set(public.pickup_policy_default_v1(), '{wave,allowed_shipment_statuses}', v_allowed, TRUE);
    v_sv_id := gen_random_uuid();

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
    )
    VALUES (
      v_sv_id,
      'pickup_policy',
      'global',
      NULL::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid,
      1,
      v_next_value,
      1,
      'Allow Console pickup failure retry wave creation from pickup_failed shipments',
      now(),
      now()
    );

    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      'pickup_policy',
      'global',
      NULL::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid,
      v_sv_id,
      v_next_value,
      now()
    );
  END IF;

  FOR v_row IN
    SELECT
      s.category,
      s.scope_type,
      s.scope_id,
      s.scope_hash,
      COALESCE(s.cached_value, public.pickup_policy_default_v1()) AS cached_value
      FROM public.settings s
     WHERE s.category = 'pickup_policy'
  LOOP
    v_allowed := COALESCE(v_row.cached_value #> '{wave,allowed_shipment_statuses}', '[]'::jsonb);

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(v_allowed) AS e(value)
       WHERE e.value = 'pickup_failed'
    ) THEN
      CONTINUE;
    END IF;

    v_allowed := v_allowed || jsonb_build_array('pickup_failed');
    v_next_value := jsonb_set(v_row.cached_value, '{wave,allowed_shipment_statuses}', v_allowed, TRUE);

    UPDATE public.settings_versions
       SET effective_until = now()
     WHERE category = 'pickup_policy'
       AND scope_type = v_row.scope_type
       AND scope_hash = v_row.scope_hash
       AND effective_until IS NULL
       AND approved_at IS NOT NULL;

    SELECT COALESCE(MAX(version) + 1, 1)
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = 'pickup_policy'
       AND scope_type = v_row.scope_type
       AND scope_hash = v_row.scope_hash;

    v_sv_id := gen_random_uuid();

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
    )
    VALUES (
      v_sv_id,
      'pickup_policy',
      v_row.scope_type,
      v_row.scope_id,
      v_row.scope_hash,
      v_next_version,
      v_next_value,
      1,
      'Allow Console pickup failure retry wave creation from pickup_failed shipments',
      now(),
      now()
    );

    UPDATE public.settings
       SET settings_version_id = v_sv_id,
           cached_value = v_next_value,
           last_updated = now()
     WHERE category = 'pickup_policy'
       AND scope_type = v_row.scope_type
       AND scope_hash = v_row.scope_hash;
  END LOOP;
END;
$do$;

CREATE OR REPLACE FUNCTION public.pickup_policy_default_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'version', 1,
    'request', jsonb_build_object(
      'shipment_status', 'pickup_requested',
      'validation_status', 'pending',
      'default_box_count', 1,
      'tracking_prefix', 'PU',
      'require_window', TRUE
    ),
    'wave', jsonb_build_object(
      'allowed_shipment_statuses', jsonb_build_array('pickup_requested', 'pickup_failed'),
      'shipment_status', 'pickup_scheduled',
      'route_run_status', 'planned',
      'inline_budget_ms', 1500,
      'inline_max_steps', 8
    ),
    'assignment', jsonb_build_object(
      'require_driver_or_partner', TRUE,
      'allow_partner_assignment', TRUE,
      'enforce_capacity', FALSE,
      'default_capacity_boxes', 100
    ),
    'failure', jsonb_build_object(
      'reschedule_reasons', jsonb_build_array(
        'no_answer',
        'phone_unreachable',
        'business_closed',
        'sender_unavailable',
        'pickup_not_ready'
      ),
      'escalation_reasons', jsonb_build_array(
        'address_not_found',
        'address_incorrect',
        'payment_issue',
        'package_damaged',
        'package_lost',
        'customer_refused',
        'access_restricted',
        'quantity_mismatch',
        'other'
      ),
      'followup', jsonb_build_object(
        'reschedule_task_type_key', 'dispatch_reschedule_pickup',
        'escalation_task_type_key', 'dispatch_pickup_escalation_review'
      )
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.pickup_policy_default_v1()
IS 'Default pickup policy including retryable failed-pickup wave creation.';

REVOKE ALL ON FUNCTION public.pickup_policy_default_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pickup_policy_default_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.pickup_policy_default_v1() TO authenticated, service_role;

DO $do$
BEGIN
  IF to_regprocedure('public.create_pickup_wave_base_v1(jsonb)') IS NULL THEN
    ALTER FUNCTION public.create_pickup_wave_v1(JSONB) RENAME TO create_pickup_wave_base_v1;
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.create_pickup_wave_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_org_id UUID := NULL;
  v_item JSONB;
  v_shipment_id UUID := NULL;
  v_shipment_ids UUID[] := '{}'::uuid[];
  v_non_retryable_count INT := 0;
BEGIN
  BEGIN
    v_org_id := NULLIF(v_input->>'organization_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v_org_id := NULL;
  END;

  IF jsonb_typeof(v_input->'shipment_ids') = 'array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_input->'shipment_ids') AS t(value)
    LOOP
      BEGIN
        IF jsonb_typeof(v_item) = 'string' THEN
          v_shipment_id := NULLIF(trim(both '"' FROM v_item::text), '')::uuid;
        ELSE
          v_shipment_id := NULLIF(v_item->>'shipment_id', '')::uuid;
        END IF;
      EXCEPTION WHEN others THEN
        v_shipment_id := NULL;
      END;

      IF v_shipment_id IS NOT NULL AND NOT (v_shipment_id = ANY(v_shipment_ids)) THEN
        v_shipment_ids := array_append(v_shipment_ids, v_shipment_id);
      END IF;
    END LOOP;
  END IF;

  IF v_org_id IS NOT NULL AND COALESCE(array_length(v_shipment_ids, 1), 0) > 0 THEN
    SELECT COUNT(*)::INT
      INTO v_non_retryable_count
      FROM public.shipments s
      LEFT JOIN public.pickup_failures pf
        ON pf.shipment_id = s.id
       AND pf.organization_id = s.organization_id
      LEFT JOIN public.lookup_definitions ld
        ON ld.category = 'pickup_failure_reason'
      LEFT JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
       AND lv.value = pf.failure_reason
       AND lv.status = 'active'
     WHERE s.id = ANY(v_shipment_ids)
       AND s.organization_id = v_org_id
       AND lower(COALESCE(s.service_type, '')) = 'pickup'
       AND lower(COALESCE(s.status, '')) = 'pickup_failed'
       AND lower(COALESCE(lv.metadata->>'retryable', 'false')) IS DISTINCT FROM 'true';

    IF v_non_retryable_count > 0 THEN
      RAISE EXCEPTION 'create_pickup_wave_v1 cannot retry non-retryable pickup failure reason(s)' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN public.create_pickup_wave_base_v1(v_input);
END;
$function$;

COMMENT ON FUNCTION public.create_pickup_wave_v1(JSONB)
IS 'Browser/API-safe pickup wave creation wrapper enforcing retryable failed-pickup reasons before delegating to the canonical base implementation.';

REVOKE ALL ON FUNCTION public.create_pickup_wave_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pickup_wave_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_pickup_wave_base_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pickup_wave_base_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605211230_console_v2_pickup_failure_retry_policy_v1'));
COMMIT;
