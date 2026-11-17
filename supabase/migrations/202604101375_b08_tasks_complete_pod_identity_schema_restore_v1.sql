-- Migration: Restore POD identity inputs on tasks.complete after COD schema refresh
-- Purpose:
--   - Preserve the COD collection fields introduced by the COD contract slice.
--   - Re-assert the alternate proof inputs required by POD identity visibility.
--   - Keep tasks.complete browser schema aligned with the FieldOps mobile shell.

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
                    'version', 'v6',
                    'title', 'Complete stop',
                    'description', 'Capture delivery handover, COD collection, alternate proof, and partial-delivery details. Proof photos are collected by the mobile shell.',
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
                      jsonb_build_object('key', 'otp_code', 'label', 'Recipient OTP', 'type', 'text', 'required', FALSE, 'placeholder', 'Enter the handover OTP when required.'),
                      jsonb_build_object('key', 'recipient_identity_kind', 'label', 'Identity type', 'type', 'text', 'required', FALSE, 'placeholder', 'National ID, passport, locker PIN, or similar.'),
                      jsonb_build_object('key', 'recipient_identity_last4', 'label', 'Identity last 4', 'type', 'text', 'required', FALSE, 'placeholder', 'Last 4 digits or characters of the confirmed identity.'),
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
             change_reason = 'Restore POD identity inputs on tasks.complete after COD schema refresh',
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
