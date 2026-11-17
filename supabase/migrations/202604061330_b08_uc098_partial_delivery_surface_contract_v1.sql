-- Migration: B08 UC098 partial delivery surface contract v1
-- Purpose:
-- - Expose partial-delivery completion_kind through the FieldOps tasks.complete schema.
-- - Let FieldOps capture delivered box numbers without knowing shipment_box UUIDs.
-- - Project partial-delivery counts onto shipment_actions for browser-safe UI reads.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061330_b08_uc098_partial_delivery_surface_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'delivery_completion_kind',
  'Canonical delivery completion kinds for full versus partial shipment handover.',
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
CROSS JOIN (VALUES
  ('full', 'Full Delivery', 'All shipment pieces were handed over during this completion.', 10, TRUE, '{}' ),
  ('partial', 'Partial Delivery', 'Only some shipment pieces were handed over; remaining pieces stay outstanding.', 20, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'delivery_completion_kind'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

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
                    'version', 'v4',
                    'title', 'Complete stop',
                    'description', 'Capture handover mode, recipient confirmation, and partial-delivery details. Proof photos are collected by the mobile shell.',
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
         change_reason = 'Expose partial delivery completion fields on tasks.complete schema',
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

ALTER TABLE public.shipment_actions
  ADD COLUMN IF NOT EXISTS delivery_completion_kind TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'completion_kind'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'completion_kind'],
            action_data #>> ARRAY['task_event_payload', 'completion_kind'],
            action_data #>> ARRAY['task_event_payload', 'pod', 'completion_kind'],
            action_data #>> ARRAY['pod', 'completion_kind'],
            action_data ->> 'completion_kind',
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS delivered_box_count INT
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(
          action_data #>> ARRAY['delivery_completion', 'delivered_box_count'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'delivered_box_count'],
          ''
        ) ~ '^-?[0-9]+$'
        THEN (
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'delivered_box_count'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'delivered_box_count']
          )
        )::INT
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS remaining_box_count INT
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(
          action_data #>> ARRAY['delivery_completion', 'remaining_box_count'],
          action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'remaining_box_count'],
          ''
        ) ~ '^-?[0-9]+$'
        THEN (
          COALESCE(
            action_data #>> ARRAY['delivery_completion', 'remaining_box_count'],
            action_data #>> ARRAY['task_event_payload', 'delivery_completion', 'remaining_box_count']
          )
        )::INT
        ELSE NULL
      END
    ) STORED;

COMMENT ON COLUMN public.shipment_actions.delivery_completion_kind IS
  'Generated UI-read projection of delivery_completion.completion_kind stored in shipment_actions.action_data.';
COMMENT ON COLUMN public.shipment_actions.delivered_box_count IS
  'Generated UI-read projection of delivery_completion.delivered_box_count stored in shipment_actions.action_data.';
COMMENT ON COLUMN public.shipment_actions.remaining_box_count IS
  'Generated UI-read projection of delivery_completion.remaining_box_count stored in shipment_actions.action_data.';

CREATE INDEX IF NOT EXISTS idx_shipment_actions_delivery_completion_kind_not_null
  ON public.shipment_actions (delivery_completion_kind, timestamp DESC)
  WHERE delivery_completion_kind IS NOT NULL;

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_found BOOLEAN := false;
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

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'shipment_actions' THEN
      v_found := true;
      v_resource := jsonb_set(
        v_resource,
        '{select}',
        jsonb_build_array(
          'id',
          'shipment_id',
          'action_type',
          'action_category',
          'canonical_status',
          'delivery_completion_kind',
          'delivered_box_count',
          'remaining_box_count',
          'handover_mode',
          'recipient_name',
          'recipient_class',
          'completion_notes',
          'location_type',
          'location_id',
          'requires_investigation',
          'investigation_status',
          'root_cause',
          'resolution',
          'resolved_at',
          'performed_by_user_id',
          'performed_by_system',
          'timestamp',
          'created_at',
          'organization_id',
          'client_id'
        ),
        true
      );
      v_resource := jsonb_set(
        v_resource,
        '{filters}',
        jsonb_build_array(
          jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
          jsonb_build_object('key', 'canonical_status', 'column', 'canonical_status', 'op', 'eq'),
          jsonb_build_object('key', 'action_type', 'column', 'action_type', 'op', 'eq'),
          jsonb_build_object('key', 'action_category', 'column', 'action_category', 'op', 'eq'),
          jsonb_build_object('key', 'delivery_completion_kind', 'column', 'delivery_completion_kind', 'op', 'eq'),
          jsonb_build_object('key', 'handover_mode', 'column', 'handover_mode', 'op', 'eq'),
          jsonb_build_object('key', 'requires_investigation', 'column', 'requires_investigation', 'op', 'eq')
        ),
        true
      );
      v_resource := jsonb_set(
        v_resource,
        '{column_labels}',
        COALESCE(v_resource->'column_labels', '{}'::jsonb) ||
          jsonb_build_object(
            'delivery_completion_kind', 'Completion kind',
            'delivered_box_count', 'Delivered boxes',
            'remaining_box_count', 'Remaining boxes',
            'handover_mode', 'Handover mode',
            'recipient_name', 'Recipient',
            'recipient_class', 'Recipient class',
            'completion_notes', 'Completion notes'
          ),
        true
      );
    END IF;
    v_updated := v_updated || jsonb_build_array(v_resource);
  END LOOP;

  IF v_found IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_read_registry missing shipment_actions resource';
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

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
           change_reason = 'Expose partial delivery projections on shipment_actions UI reads',
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
END $$;

SELECT pg_advisory_unlock(hashtext('202604061330_b08_uc098_partial_delivery_surface_contract_v1'));
COMMIT;
