-- Migration: Dispatch task-contact policy support readback v1
-- Purpose:
--   - Merge row-driven communication_policy.support_contacts into the
--     canonical route-stop task contact metadata helper.
--   - Keep task-contact support readback route-run scoped and free of
--     literal contact fallbacks or client lookup behavior.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606301840_dispatch_task_contact_policy_support_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_stop_task_contact_metadata_v1(
  p_route_stop_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_stop RECORD;
  v_assignment JSONB := '{}'::jsonb;
  v_communication_policy JSONB := '{}'::jsonb;
  v_assignment_support_contacts JSONB := '[]'::jsonb;
  v_policy_support_contacts JSONB := '[]'::jsonb;
  v_support_contacts JSONB := '[]'::jsonb;
BEGIN
  IF p_route_stop_id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT
    rs.id,
    rs.route_run_id,
    rs.client_id,
    rs.shipment_id,
    rs.sequence_order,
    rs.stop_kind,
    rr.branch_id,
    s.sender_id,
    s.tracking_number,
    COALESCE(
      NULLIF(btrim(COALESCE(r.name, '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'customer_name', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'recipient_name', '')), '')
    ) AS customer_name,
    COALESCE(
      NULLIF(btrim(COALESCE(r.phone_number, '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'customer_phone', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata->>'recipient_phone', '')), ''),
      NULLIF(btrim(COALESCE(s.metadata #>> '{customer,phone_number}', '')), '')
    ) AS customer_phone,
    a.raw_input,
    a.normalized_line1,
    a.normalized_line2,
    a.building_number,
    a.district,
    a.city,
    a.province,
    a.postal_code,
    a.country,
    a.additional_directions
  INTO v_stop
  FROM public.route_stops rs
  JOIN public.route_runs rr
    ON rr.id = rs.route_run_id
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  LEFT JOIN public.recipients r
    ON r.id = s.recipient_id
   AND r.client_id = s.client_id
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
   AND a.client_id = s.client_id
  WHERE rs.id = p_route_stop_id
  LIMIT 1;

  IF v_stop.id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  v_assignment := COALESCE(public.route_run_assignment_projection_v1(v_stop.route_run_id), '{}'::jsonb);
  v_assignment_support_contacts := COALESCE(v_assignment #> '{metadata,support_contacts}', '[]'::jsonb);
  IF jsonb_typeof(v_assignment_support_contacts) IS DISTINCT FROM 'array' THEN
    v_assignment_support_contacts := '[]'::jsonb;
  END IF;

  SELECT COALESCE(value, '{}'::jsonb)
    INTO v_communication_policy
    FROM public.resolve_communication_policy(
      jsonb_strip_nulls(
        jsonb_build_object(
          'resource_type', 'route_stop',
          'resource_id', v_stop.id,
          'route_stop_id', v_stop.id,
          'route_run_id', v_stop.route_run_id,
          'branch_id', v_stop.branch_id,
          'client_id', v_stop.client_id,
          'sender_id', v_stop.sender_id
        )
      )
    )
   LIMIT 1;

  v_policy_support_contacts := COALESCE(v_communication_policy->'support_contacts', '[]'::jsonb);
  IF jsonb_typeof(v_policy_support_contacts) IS DISTINCT FROM 'array' THEN
    v_policy_support_contacts := '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(deduped.value ORDER BY deduped.first_ordinal), '[]'::jsonb)
    INTO v_support_contacts
    FROM (
      SELECT
        contact_key,
        (array_agg(contact_value ORDER BY contact_ordinal))[1] AS value,
        min(contact_ordinal) AS first_ordinal
      FROM (
        SELECT
          contact_value,
          contact_ordinal,
          COALESCE(
            NULLIF(contact_value->>'id', ''),
            NULLIF(
              concat_ws(
                ':',
                NULLIF(contact_value->>'role', ''),
                NULLIF(contact_value->>'label', ''),
                NULLIF(contact_value->>'phone_number', ''),
                NULLIF(contact_value->>'phone', '')
              ),
              ''
            ),
            contact_value::text
          ) AS contact_key
        FROM jsonb_array_elements(v_assignment_support_contacts || v_policy_support_contacts)
          WITH ORDINALITY AS contact(contact_value, contact_ordinal)
        WHERE jsonb_typeof(contact_value) = 'object'
      ) normalized
      GROUP BY contact_key
    ) deduped;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_id', v_stop.route_run_id,
      'route_stop_id', v_stop.id,
      'branch_id', v_stop.branch_id,
      'client_id', v_stop.client_id,
      'sender_id', v_stop.sender_id,
      'route_stop',
        jsonb_strip_nulls(
          jsonb_build_object(
            'id', v_stop.id,
            'route_run_id', v_stop.route_run_id,
            'shipment_id', v_stop.shipment_id,
            'client_id', v_stop.client_id,
            'branch_id', v_stop.branch_id,
            'sequence_order', v_stop.sequence_order,
            'stop_kind', v_stop.stop_kind
          )
        ),
      'customer',
        CASE
          WHEN v_stop.customer_name IS NULL
            AND v_stop.customer_phone IS NULL
            AND v_stop.tracking_number IS NULL
          THEN NULL
          ELSE jsonb_strip_nulls(
            jsonb_build_object(
              'name', v_stop.customer_name,
              'phone_number', v_stop.customer_phone,
              'reference', v_stop.tracking_number,
              'tracking_number', v_stop.tracking_number
            )
          )
        END,
      'contact',
        CASE
          WHEN v_stop.customer_phone IS NULL THEN NULL
          ELSE jsonb_build_object('phone_number', v_stop.customer_phone)
        END,
      'address',
        CASE
          WHEN v_stop.raw_input IS NULL
            AND v_stop.normalized_line1 IS NULL
            AND v_stop.normalized_line2 IS NULL
            AND v_stop.district IS NULL
            AND v_stop.city IS NULL
            AND v_stop.province IS NULL
            AND v_stop.postal_code IS NULL
          THEN NULL
          ELSE jsonb_strip_nulls(
            jsonb_build_object(
              'address', v_stop.raw_input,
              'raw_input', v_stop.raw_input,
              'line1', v_stop.normalized_line1,
              'line2', v_stop.normalized_line2,
              'building_number', v_stop.building_number,
              'district', v_stop.district,
              'city', v_stop.city,
              'province', v_stop.province,
              'postal_code', v_stop.postal_code,
              'country', v_stop.country,
              'additional_directions', v_stop.additional_directions
            )
          )
        END,
      'support_contacts',
        CASE
          WHEN jsonb_array_length(v_support_contacts) = 0 THEN NULL
          ELSE v_support_contacts
        END
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID)
  IS 'Canonical route_stop task metadata fragment for Field Ops task context. Carries customer/address data from the shipment plus support_contacts from route assignment metadata and row-driven communication_policy support contacts.';

REVOKE ALL ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.route_stop_task_contact_metadata_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606301840_dispatch_task_contact_policy_support_readback_v1'));
COMMIT;
