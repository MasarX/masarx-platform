-- Migration: public tracking partial-delivery split-state projection
-- Purpose:
-- - Surface non-sensitive partial-delivery box counts from canonical shipment
--   action metadata so customer tracking can rehydrate split shipment state.
-- - Keep public tracking read-only and derived from shipment_actions plus the
--   shipment delivery_completion projection.

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('20261122029001_public_tracking_partial_delivery_counts_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.public_tracking_build_payload_v1(
  p_session_id UUID,
  p_policy JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_session RECORD;
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_phone_keep_last INT;
  v_email_keep_prefix INT;
  v_name_keep_prefix INT;
  v_short_addr_keep_last INT;
  v_timeline_limit INT;
  v_allowed_action_types TEXT[];
  v_timeline JSONB := '[]'::jsonb;
  v_available_dates JSONB := '[]'::jsonb;
  v_delivery_completion JSONB := NULL;
  v_reschedule_enabled BOOLEAN;
  v_location_change_enabled BOOLEAN;
  v_reschedule_horizon_days INT;
  v_short_national_address TEXT;
BEGIN
  SELECT
    ts.id,
    ts.organization_id,
    ts.client_id,
    ts.sender_id,
    ts.shipment_id,
    ts.recipient_id,
    ts.status AS session_status,
    ts.expires_at,
    s.tracking_number,
    s.client_reference_number,
    s.carrier_reference_number,
    s.status AS shipment_status,
    s.service_type,
    s.box_count,
    s.metadata AS shipment_metadata,
    s.created_at AS shipment_created_at,
    s.promised_delivery_date,
    s.promised_delivery_at,
    s.promised_window_start_at,
    s.promised_window_end_at,
    r.name AS recipient_name,
    r.phone_number AS recipient_phone,
    r.email AS recipient_email,
    a.city AS destination_city,
    a.district AS destination_district,
    a.building_number AS destination_building_number,
    a.postal_code AS destination_postal_code
  INTO v_session
  FROM public.tracking_sessions ts
  JOIN public.shipments s
    ON s.id = ts.shipment_id
   AND s.client_id = ts.client_id
  LEFT JOIN public.recipients r
    ON r.id = ts.recipient_id
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
   AND a.client_id = s.client_id
  WHERE ts.id = p_session_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_policy = '{}'::jsonb THEN
    v_policy := public.public_tracking_policy_v1(jsonb_build_object(
      'organization_id', v_session.organization_id,
      'client_id', v_session.client_id,
      'sender_id', v_session.sender_id
    ));
  END IF;

  v_phone_keep_last := public.public_tracking_int_v1(v_policy, ARRAY['masking','phone_keep_last'], 3, 1, 6);
  v_email_keep_prefix := public.public_tracking_int_v1(v_policy, ARRAY['masking','email_keep_prefix'], 1, 1, 8);
  v_name_keep_prefix := public.public_tracking_int_v1(v_policy, ARRAY['masking','name_keep_prefix'], 1, 1, 8);
  v_short_addr_keep_last := public.public_tracking_int_v1(v_policy, ARRAY['masking','short_national_address_keep_last'], 4, 1, 8);
  v_timeline_limit := public.public_tracking_int_v1(v_policy, ARRAY['timeline','max_items'], 12, 1, 50);
  v_allowed_action_types := public.public_tracking_text_array_v1(v_policy, ARRAY['timeline','allowed_action_types']);
  v_reschedule_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','reschedule','enabled'], TRUE);
  v_location_change_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','location_change','enabled'], TRUE);
  v_reschedule_horizon_days := public.public_tracking_int_v1(v_policy, ARRAY['actions','reschedule','horizon_days'], 7, 1, 60);

  v_short_national_address := NULLIF(
    trim(concat_ws(' ', NULLIF(v_session.destination_building_number, ''), NULLIF(v_session.destination_postal_code, ''))),
    ''
  );

  SELECT jsonb_strip_nulls(
           jsonb_build_object(
             'completion_kind', sa.delivery_completion_kind,
             'box_count',
               CASE
                 WHEN COALESCE(sa.action_data #>> ARRAY['delivery_completion','box_count'], '') ~ '^[0-9]+$'
                   THEN (sa.action_data #>> ARRAY['delivery_completion','box_count'])::int
                 ELSE NULL
               END,
             'delivered_box_count', sa.delivered_box_count,
             'remaining_box_count', sa.remaining_box_count,
             'delivered_box_numbers',
               CASE
                 WHEN jsonb_typeof(sa.action_data #> ARRAY['delivery_completion','delivered_box_numbers']) = 'array'
                   THEN sa.action_data #> ARRAY['delivery_completion','delivered_box_numbers']
                 ELSE NULL
               END
           )
         )
    INTO v_delivery_completion
    FROM public.shipment_actions sa
   WHERE sa.shipment_id = v_session.shipment_id
     AND sa.client_id = v_session.client_id
     AND (
       sa.delivery_completion_kind IS NOT NULL
       OR sa.delivered_box_count IS NOT NULL
       OR sa.remaining_box_count IS NOT NULL
       OR jsonb_typeof(sa.action_data #> ARRAY['delivery_completion','delivered_box_numbers']) = 'array'
     )
   ORDER BY sa.timestamp DESC, sa.created_at DESC
   LIMIT 1;

  IF v_delivery_completion IS NULL OR v_delivery_completion = '{}'::jsonb THEN
    SELECT jsonb_strip_nulls(
             jsonb_build_object(
               'completion_kind', NULLIF(v_session.shipment_metadata #>> ARRAY['delivery_completion','completion_kind'], ''),
               'box_count',
                 CASE
                   WHEN COALESCE(v_session.shipment_metadata #>> ARRAY['delivery_completion','box_count'], '') ~ '^[0-9]+$'
                     THEN (v_session.shipment_metadata #>> ARRAY['delivery_completion','box_count'])::int
                   ELSE NULL
                 END,
               'delivered_box_count',
                 CASE
                   WHEN COALESCE(v_session.shipment_metadata #>> ARRAY['delivery_completion','delivered_box_count'], '') ~ '^[0-9]+$'
                     THEN (v_session.shipment_metadata #>> ARRAY['delivery_completion','delivered_box_count'])::int
                   ELSE NULL
                 END,
               'remaining_box_count',
                 CASE
                   WHEN COALESCE(v_session.shipment_metadata #>> ARRAY['delivery_completion','remaining_box_count'], '') ~ '^[0-9]+$'
                     THEN (v_session.shipment_metadata #>> ARRAY['delivery_completion','remaining_box_count'])::int
                   ELSE NULL
                 END,
               'delivered_box_numbers',
                 CASE
                   WHEN jsonb_typeof(v_session.shipment_metadata #> ARRAY['delivery_completion','delivered_box_numbers']) = 'array'
                     THEN v_session.shipment_metadata #> ARRAY['delivery_completion','delivered_box_numbers']
                   ELSE NULL
                 END
             )
           )
      INTO v_delivery_completion;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'action_type', sa.action_type,
          'action_category', sa.action_category,
          'status', sa.canonical_status,
          'timestamp', sa.timestamp,
          'summary', COALESCE(NULLIF(sa.canonical_status, ''), replace(sa.action_type, '_', ' ')),
          'delivery_completion',
            CASE
              WHEN sa.delivery_completion_kind IS NOT NULL
                OR sa.delivered_box_count IS NOT NULL
                OR sa.remaining_box_count IS NOT NULL
                OR jsonb_typeof(sa.action_data #> ARRAY['delivery_completion','delivered_box_numbers']) = 'array'
              THEN jsonb_strip_nulls(jsonb_build_object(
                'completion_kind', sa.delivery_completion_kind,
                'box_count',
                  CASE
                    WHEN COALESCE(sa.action_data #>> ARRAY['delivery_completion','box_count'], '') ~ '^[0-9]+$'
                      THEN (sa.action_data #>> ARRAY['delivery_completion','box_count'])::int
                    ELSE NULL
                  END,
                'delivered_box_count', sa.delivered_box_count,
                'remaining_box_count', sa.remaining_box_count,
                'delivered_box_numbers',
                  CASE
                    WHEN jsonb_typeof(sa.action_data #> ARRAY['delivery_completion','delivered_box_numbers']) = 'array'
                      THEN sa.action_data #> ARRAY['delivery_completion','delivered_box_numbers']
                    ELSE NULL
                  END
              ))
              ELSE NULL
            END
        )
      )
      ORDER BY sa.timestamp DESC
    ),
    '[]'::jsonb
  )
  INTO v_timeline
  FROM (
    SELECT
      sa.action_type,
      sa.action_category,
      sa.canonical_status,
      sa.timestamp,
      sa.delivery_completion_kind,
      sa.delivered_box_count,
      sa.remaining_box_count,
      sa.action_data,
      sa.created_at
    FROM public.shipment_actions sa
    WHERE sa.shipment_id = v_session.shipment_id
      AND sa.client_id = v_session.client_id
      AND (
        COALESCE(array_length(v_allowed_action_types, 1), 0) = 0
        OR sa.action_type = ANY(v_allowed_action_types)
      )
    ORDER BY sa.timestamp DESC
    LIMIT v_timeline_limit
  ) sa;

  IF v_reschedule_enabled THEN
    BEGIN
      SELECT COALESCE(
        jsonb_agg(to_jsonb(d.slot_date) ORDER BY d.slot_date ASC),
        '[]'::jsonb
      )
      INTO v_available_dates
      FROM (
        SELECT DISTINCT slot_date
        FROM public.list_delivery_slots_v1(jsonb_build_object(
          'shipment_id', v_session.shipment_id,
          'client_id', v_session.client_id,
          'start_date', workflow_now()::date,
          'days', v_reschedule_horizon_days,
          'include_unavailable', FALSE
        ))
        WHERE is_available IS TRUE
      ) d;
    EXCEPTION
      WHEN others THEN
        v_available_dates := '[]'::jsonb;
    END;
  END IF;

  RETURN jsonb_build_object(
    'shipment', jsonb_strip_nulls(jsonb_build_object(
      'tracking_number', v_session.tracking_number,
      'client_reference_number', NULLIF(btrim(v_session.client_reference_number), ''),
      'carrier_reference_number', NULLIF(btrim(v_session.carrier_reference_number), ''),
      'status', v_session.shipment_status,
      'service_type', v_session.service_type,
      'box_count', v_session.box_count,
      'delivery_completion', CASE WHEN v_delivery_completion = '{}'::jsonb THEN NULL ELSE v_delivery_completion END,
      'created_at', v_session.shipment_created_at,
      'promised_delivery_date', v_session.promised_delivery_date,
      'promised_delivery_at', v_session.promised_delivery_at,
      'promised_window_start_at', v_session.promised_window_start_at,
      'promised_window_end_at', v_session.promised_window_end_at
    )),
    'recipient', jsonb_strip_nulls(jsonb_build_object(
      'name', public.public_tracking_mask_name_v1(v_session.recipient_name, v_name_keep_prefix),
      'phone', public.public_tracking_mask_phone_v1(v_session.recipient_phone, v_phone_keep_last),
      'email', public.public_tracking_mask_email_v1(v_session.recipient_email, v_email_keep_prefix)
    )),
    'address', jsonb_strip_nulls(jsonb_build_object(
      'city', NULLIF(btrim(v_session.destination_city), ''),
      'district', NULLIF(btrim(v_session.destination_district), ''),
      'short_national_address', public.public_tracking_mask_short_national_address_v1(v_short_national_address, v_short_addr_keep_last)
    )),
    'timeline', COALESCE(v_timeline, '[]'::jsonb),
    'actions', jsonb_build_object(
      'reschedule', jsonb_build_object(
        'enabled', v_reschedule_enabled,
        'available_dates', COALESCE(v_available_dates, '[]'::jsonb)
      ),
      'location_change', jsonb_build_object(
        'enabled', v_location_change_enabled,
        'requires_map_pin', TRUE,
        'requires_short_national_address', TRUE
      )
    ),
    'session', jsonb_strip_nulls(jsonb_build_object(
      'status', v_session.session_status,
      'expires_at', v_session.expires_at
    )),
    'verification', jsonb_build_object(
      'phone_digits', public.public_tracking_int_v1(v_policy, ARRAY['lookup','verification_phone_digits'], 3, 3, 6)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.public_tracking_build_payload_v1(UUID, JSONB)
  IS 'Builds the public tracking payload with masked recipient data, policy-driven actions, timeline, and non-sensitive partial-delivery split-state counts.';

COMMIT;
