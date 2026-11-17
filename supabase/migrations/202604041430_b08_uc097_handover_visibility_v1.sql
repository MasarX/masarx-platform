-- Migration: B08 UC097 handover visibility projection for shipment actions UI reads
BEGIN;
SELECT pg_advisory_lock(hashtext('202604041430_b08_uc097_handover_visibility_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.shipment_actions
  ADD COLUMN IF NOT EXISTS handover_mode TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['task_event_payload', 'handover_mode'],
            action_data #>> ARRAY['task_event_payload', 'pod', 'handover_mode'],
            action_data #>> ARRAY['pod', 'handover_mode'],
            action_data ->> 'handover_mode',
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS recipient_name TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['task_event_payload', 'recipient_name'],
            action_data #>> ARRAY['task_event_payload', 'pod', 'recipient_name'],
            action_data #>> ARRAY['pod', 'recipient_name'],
            action_data ->> 'recipient_name',
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS recipient_class TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['task_event_payload', 'recipient_class'],
            action_data #>> ARRAY['task_event_payload', 'pod', 'recipient_class'],
            action_data #>> ARRAY['pod', 'recipient_class'],
            action_data ->> 'recipient_class',
            ''
          )
        ),
        ''
      )
    ) STORED,
  ADD COLUMN IF NOT EXISTS completion_notes TEXT
    GENERATED ALWAYS AS (
      NULLIF(
        btrim(
          COALESCE(
            action_data #>> ARRAY['task_event_payload', 'completion_notes'],
            action_data #>> ARRAY['pod', 'completion_notes'],
            action_data ->> 'completion_notes',
            ''
          )
        ),
        ''
      )
    ) STORED;

COMMENT ON COLUMN public.shipment_actions.handover_mode IS
  'Generated UI-read projection of the delivery handover mode stored in shipment_actions.action_data.';
COMMENT ON COLUMN public.shipment_actions.recipient_name IS
  'Generated UI-read projection of the delivery recipient name stored in shipment_actions.action_data.';
COMMENT ON COLUMN public.shipment_actions.recipient_class IS
  'Generated UI-read projection of the delivery recipient class stored in shipment_actions.action_data.';
COMMENT ON COLUMN public.shipment_actions.completion_notes IS
  'Generated UI-read projection of completion notes stored in shipment_actions.action_data.';

CREATE INDEX IF NOT EXISTS idx_shipment_actions_handover_mode_not_null
  ON public.shipment_actions (handover_mode, timestamp DESC)
  WHERE handover_mode IS NOT NULL;

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
           change_reason = 'Expose delivery handover projections on shipment_actions UI reads',
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

SELECT pg_advisory_unlock(hashtext('202604041430_b08_uc097_handover_visibility_v1'));
COMMIT;
