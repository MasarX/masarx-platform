-- Migration: Reconcile tasks.complete COD + alternate proof schema v1
-- Purpose:
--   - Keep the canonical tasks.complete input schema aligned after the COD
--     contract rewrite so alternate proof fields (OTP / identity) remain
--     exposed alongside COD collection fields.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604101710_b08_task_complete_identity_schema_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
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
                  '{execution,input_schema,fields}',
                  (
                    WITH current_fields AS (
                      SELECT COALESCE(item #> '{execution,input_schema,fields}', '[]'::jsonb) AS fields
                    ),
                    base_fields AS (
                      SELECT CASE
                        WHEN jsonb_typeof(fields) = 'array' THEN fields
                        ELSE '[]'::jsonb
                      END AS fields
                      FROM current_fields
                    ),
                    augmented_fields AS (
                      SELECT
                        CASE
                          WHEN NOT EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements(fields) AS field(value)
                            WHERE field.value->>'key' = 'otp_code'
                          ) THEN fields || jsonb_build_array(
                            jsonb_build_object(
                              'key', 'otp_code',
                              'label', 'Recipient OTP',
                              'type', 'text',
                              'required', FALSE,
                              'placeholder', 'Enter the handover OTP when required.'
                            )
                          )
                          ELSE fields
                        END AS fields
                      FROM base_fields
                    ),
                    augmented_fields_2 AS (
                      SELECT
                        CASE
                          WHEN NOT EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements(fields) AS field(value)
                            WHERE field.value->>'key' = 'recipient_identity_kind'
                          ) THEN fields || jsonb_build_array(
                            jsonb_build_object(
                              'key', 'recipient_identity_kind',
                              'label', 'Identity type',
                              'type', 'text',
                              'required', FALSE,
                              'placeholder', 'National ID, passport, locker PIN, or similar.'
                            )
                          )
                          ELSE fields
                        END AS fields
                      FROM augmented_fields
                    )
                    SELECT CASE
                      WHEN NOT EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(fields) AS field(value)
                        WHERE field.value->>'key' = 'recipient_identity_last4'
                      ) THEN fields || jsonb_build_array(
                        jsonb_build_object(
                          'key', 'recipient_identity_last4',
                          'label', 'Identity last 4',
                          'type', 'text',
                          'required', FALSE,
                          'placeholder', 'Last 4 digits or characters of the confirmed identity.'
                        )
                      )
                      ELSE fields
                    END
                    FROM augmented_fields_2
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
             change_reason = 'Restore alternate proof fields on tasks.complete alongside COD schema',
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

SELECT pg_advisory_unlock(hashtext('202604101710_b08_task_complete_identity_schema_reconcile_v1'));

COMMIT;
