-- Console V2 recipient lifecycle gap closure.
-- Adds canonical operator-side recipient create/delete RPCs plus api-schema wrappers.
-- Update remains owned by 202604301040_recipient_update_v1.sql.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031940_recipient_create_delete_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('decision_category', 'Business decision categories for decision_log', 'engineering', 'tier_1', FALSE),
  ('decision_outcome', 'Decision outcomes for decision_log', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;

WITH categories(value, label, description, sort_order) AS (
  VALUES
    ('recipients.create', 'Recipients Create', 'Recipient create decisions emitted by canonical RPCs.', 1900),
    ('recipients.delete', 'Recipients Delete', 'Recipient delete decisions emitted by canonical RPCs.', 1910)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  c.value,
  c.label,
  c.description,
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'recipient_create_delete_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, description, sort_order) AS (
  VALUES
    ('deleted', 'Deleted', 'Resource deletion decision outcome.', 1900)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  o.value,
  o.label,
  o.description,
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'recipient_create_delete_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.recipient_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID;
  v_client_id UUID := NULLIF(p_args->>'client_id', '')::uuid;
  v_client_org UUID;
  v_external_id TEXT := NULLIF(btrim(COALESCE(p_args->>'external_id', '')), '');
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_phone TEXT := NULLIF(btrim(COALESCE(p_args->>'phone_number', '')), '');
  v_email TEXT := NULLIF(btrim(COALESCE(p_args->>'email', '')), '');
  v_preferred_language TEXT := NULLIF(btrim(COALESCE(p_args->>'preferred_language', '')), '');
  v_preferred_comm_channel TEXT := NULLIF(btrim(COALESCE(p_args->>'preferred_comm_channel', '')), '');
  v_quiet_hours_start TEXT := NULLIF(btrim(COALESCE(p_args->>'quiet_hours_start', '')), '');
  v_quiet_hours_end TEXT := NULLIF(btrim(COALESCE(p_args->>'quiet_hours_end', '')), '');
  v_communication_preferences JSONB := CASE
    WHEN p_args ? 'communication_preferences' THEN p_args->'communication_preferences'
    ELSE NULL
  END;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'recipient_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('recipients.write');

  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'recipient_create_v1 requires client_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'recipient_create_v1 requires name'
      USING ERRCODE = '23502';
  END IF;
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'recipient_create_v1 requires phone_number'
      USING ERRCODE = '23502';
  END IF;

  SELECT organization_id INTO v_client_org FROM public.clients WHERE id = v_client_id;
  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'recipient_create_v1 client % not found', v_client_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_client_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'recipient_create_v1 client % outside tenant scope', v_client_id
      USING ERRCODE = '42501';
  END IF;

  IF v_preferred_language IS NULL THEN
    INSERT INTO public.recipients (
      organization_id,
      client_id,
      external_id,
      name,
      phone_number,
      phone_validation_status,
      email,
      preferred_comm_channel,
      quiet_hours_start,
      quiet_hours_end,
      communication_preferences
    ) VALUES (
      v_client_org,
      v_client_id,
      v_external_id,
      v_name,
      v_phone,
      'pending',
      v_email,
      v_preferred_comm_channel,
      v_quiet_hours_start::time,
      v_quiet_hours_end::time,
      v_communication_preferences
    )
    RETURNING id INTO v_resource_id;
  ELSE
    INSERT INTO public.recipients (
      organization_id,
      client_id,
      external_id,
      name,
      phone_number,
      phone_validation_status,
      email,
      preferred_language,
      preferred_comm_channel,
      quiet_hours_start,
      quiet_hours_end,
      communication_preferences
    ) VALUES (
      v_client_org,
      v_client_id,
      v_external_id,
      v_name,
      v_phone,
      'pending',
      v_email,
      v_preferred_language,
      v_preferred_comm_channel,
      v_quiet_hours_start::time,
      v_quiet_hours_end::time,
      v_communication_preferences
    )
    RETURNING id INTO v_resource_id;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_client_org, 'recipients.create', 'recipient', v_resource_id,
    'recipient_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object(
      'client_id', v_client_id,
      'external_id', v_external_id,
      'name', v_name,
      'phone_validation_status', 'pending',
      'preferred_language', v_preferred_language,
      'preferred_comm_channel', v_preferred_comm_channel
    )),
    'recipient_create_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_client_org, 'recipient.created', 'recipient', v_resource_id,
    jsonb_strip_nulls(jsonb_build_object('client_id', v_client_id, 'name', v_name, 'external_id', v_external_id)),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'recipient_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.recipient_delete_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'recipient_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.recipients%ROWTYPE;
  v_shipment_count INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'recipient_delete_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('recipients.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'recipient_delete_v1 requires recipient_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.recipients WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'recipient_delete_v1 recipient % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'recipient_delete_v1 recipient % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_shipment_count
    FROM public.shipments
   WHERE recipient_id = v_resource_id;

  DELETE FROM public.recipients WHERE id = v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id, 'recipients.delete', 'recipient', v_resource_id,
    'recipient_delete_v1', 'deleted',
    jsonb_strip_nulls(jsonb_build_object(
      'client_id', v_before.client_id,
      'external_id', v_before.external_id,
      'name', v_before.name,
      'reason', v_reason,
      'shipment_reference_count', v_shipment_count
    )),
    'recipient_delete_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'recipient.deleted', 'recipient', v_resource_id,
    jsonb_strip_nulls(jsonb_build_object(
      'client_id', v_before.client_id,
      'external_id', v_before.external_id,
      'reason', v_reason,
      'shipment_reference_count', v_shipment_count
    )),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'recipient_id', v_resource_id,
    'deleted', true,
    'shipment_reference_count', v_shipment_count,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.recipient_create_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recipient_delete_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recipient_create_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recipient_delete_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.recipient_create_v1(jsonb)
  IS 'Canonical Console V2 write RPC: create public.recipients row for an in-scope client + decision_log + domain_event. Capability: recipients.write.';
COMMENT ON FUNCTION public.recipient_delete_v1(jsonb)
  IS 'Canonical Console V2 write RPC: delete public.recipients row with audit/event lineage. Capability: recipients.write.';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.recipient_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.recipient_create_v1(p_args);
$function$;

CREATE OR REPLACE FUNCTION api.recipient_delete_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.recipient_delete_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION api.recipient_create_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.recipient_delete_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.recipient_create_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.recipient_delete_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.recipient_create_v1(jsonb)
  IS 'api-schema wrapper exposing public.recipient_create_v1 for browser Supabase clients.';
COMMENT ON FUNCTION api.recipient_delete_v1(jsonb)
  IS 'api-schema wrapper exposing public.recipient_delete_v1 for browser Supabase clients.';

SELECT pg_advisory_unlock(hashtext('202605031940_recipient_create_delete_v1'));
COMMIT;
