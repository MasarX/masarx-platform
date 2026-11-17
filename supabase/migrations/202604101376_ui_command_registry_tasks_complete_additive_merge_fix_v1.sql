-- Migration: Keep tasks.complete ui_command_registry schema additive across B08 slices
-- Purpose:
-- - Repair the shared tasks.complete input schema after COD payment fields replaced
--   earlier alternate-proof inputs.
-- - Merge canonical partial-delivery, COD, and POD identity fields by key for every
--   ui_command_registry scope without dropping any later extra fields.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101376_ui_command_registry_tasks_complete_additive_merge_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := '{}'::jsonb;
  v_next JSONB := '{}'::jsonb;
  v_commands JSONB := '[]'::jsonb;
  v_updated_commands JSONB := '[]'::jsonb;
  v_command JSONB := '{}'::jsonb;
  v_input_schema JSONB := '{}'::jsonb;
  v_current_fields JSONB := '[]'::jsonb;
  v_required_fields JSONB := jsonb_build_array(
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
      'key', 'payment_outcome',
      'label', 'Payment outcome',
      'type', 'lookup',
      'lookup_category', 'payment_collection_outcome',
      'required', FALSE,
      'default_value', 'collected'
    ),
    jsonb_build_object(
      'key', 'payment_method',
      'label', 'Payment method',
      'type', 'lookup',
      'lookup_category', 'payment_collection_method',
      'required', FALSE
    ),
    jsonb_build_object(
      'key', 'payment_amount',
      'label', 'Collected amount',
      'type', 'number',
      'required', FALSE,
      'placeholder', 'Enter the amount collected from the customer'
    ),
    jsonb_build_object(
      'key', 'payment_receipt_context',
      'label', 'Receipt context',
      'type', 'textarea',
      'required', FALSE,
      'placeholder', 'Receipt number, POS reference, or payment acknowledgement details.'
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
  );
  v_required_keys TEXT[] := ARRAY[
    'completion_kind',
    'delivered_box_numbers',
    'payment_outcome',
    'payment_method',
    'payment_amount',
    'payment_receipt_context',
    'handover_mode',
    'recipient_name',
    'recipient_class',
    'otp_code',
    'recipient_identity_kind',
    'recipient_identity_last4',
    'completion_notes'
  ];
  v_required_field JSONB := NULL;
  v_existing_field JSONB := NULL;
  v_merged_fields JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_updated_commands := '[]'::jsonb;

    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      IF v_command->>'key' = 'tasks.complete' THEN
        v_input_schema := COALESCE(v_command #> '{execution,input_schema}', '{}'::jsonb);
        IF jsonb_typeof(v_input_schema) IS DISTINCT FROM 'object' THEN
          v_input_schema := '{}'::jsonb;
        END IF;

        v_current_fields := COALESCE(v_input_schema->'fields', '[]'::jsonb);
        IF jsonb_typeof(v_current_fields) IS DISTINCT FROM 'array' THEN
          v_current_fields := '[]'::jsonb;
        END IF;

        v_merged_fields := '[]'::jsonb;

        FOR v_required_field IN
          SELECT value
          FROM jsonb_array_elements(v_required_fields) AS value
        LOOP
          SELECT existing.value
            INTO v_existing_field
          FROM jsonb_array_elements(v_current_fields) AS existing(value)
          WHERE existing.value->>'key' = v_required_field->>'key'
          LIMIT 1;

          v_merged_fields := v_merged_fields || jsonb_build_array(
            CASE
              WHEN v_existing_field IS NULL THEN v_required_field
              ELSE jsonb_strip_nulls(v_existing_field || v_required_field)
            END
          );

          v_existing_field := NULL;
        END LOOP;

        FOR v_existing_field IN
          SELECT value
          FROM jsonb_array_elements(v_current_fields) AS value
        LOOP
          IF NOT (COALESCE(v_existing_field->>'key', '') = ANY (v_required_keys)) THEN
            v_merged_fields := v_merged_fields || jsonb_build_array(v_existing_field);
          END IF;
        END LOOP;

        v_input_schema := jsonb_strip_nulls(
          v_input_schema || jsonb_build_object(
            'version', 'v6',
            'title', 'Complete stop',
            'description', 'Capture delivery handover, COD collection when required, alternate proof, and partial-delivery details. Proof photos are collected by the mobile shell.',
            'fields', v_merged_fields
          )
        );

        v_command := jsonb_set(v_command, '{execution,input_schema}', v_input_schema, TRUE);
      END IF;

      v_updated_commands := v_updated_commands || jsonb_build_array(v_command);
    END LOOP;

    v_next := jsonb_set(v_current, '{commands}', v_updated_commands, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = COALESCE(v_row.version, 0) + 1,
             change_reason = 'Merge COD and alternate-proof fields on tasks.complete schema',
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

SELECT pg_advisory_unlock(hashtext('202604101375_ui_command_registry_tasks_complete_additive_merge_fix_v1'));
COMMIT;
