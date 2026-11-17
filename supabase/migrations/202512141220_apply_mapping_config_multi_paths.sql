-- Migration: apply_mapping_config multi-path support + Dialog360 reply mapping refresh
-- Purpose:
--   - Allow mapping_configs.transforms fields to specify an array of candidate paths (first match wins).
--   - Update Dialog360 reply inbound mapping to cover WhatsApp Cloud payload shapes (text + interactive).
-- Date: 2025-12-14

BEGIN;

-- Apply mapping_config with JSONPath normalization and multi-path support.
CREATE OR REPLACE FUNCTION public.apply_mapping_config(
    p_source JSONB,
    p_mapping_config_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $function$
DECLARE
    v_config RECORD;
    v_result JSONB := '{}'::JSONB;
    v_target TEXT;
    v_spec JSONB;
    v_field_key TEXT;
    v_field_spec JSONB;
    v_path TEXT;
    v_jsonpath TEXT;
    v_field_val JSONB;
    v_object JSONB;
    v_candidate_paths TEXT[];
BEGIN
    IF p_source IS NULL OR p_mapping_config_id IS NULL THEN
        RETURN p_source;
    END IF;

    SELECT mapping_config
      INTO v_config
      FROM public.mapping_configs
     WHERE id = p_mapping_config_id;

    IF NOT FOUND OR v_config.mapping_config IS NULL THEN
        RETURN p_source;
    END IF;

    -- Prefer explicit field_mappings when present.
    IF v_config.mapping_config ? 'field_mappings' THEN
        v_result := public.jsonb_extract_fields(
            p_source,
            v_config.mapping_config->'field_mappings'
        );
        RETURN v_result;
    END IF;

    -- Support nested object transforms (e.g., communication.reply payloads).
    IF v_config.mapping_config ? 'transforms' THEN
        v_result := '{}'::jsonb;
        FOR v_target, v_spec IN
            SELECT key, value
              FROM jsonb_each(v_config.mapping_config->'transforms')
        LOOP
            IF jsonb_typeof(v_spec) = 'object' THEN
                v_object := '{}'::jsonb;
                FOR v_field_key, v_field_spec IN
                    SELECT key, value
                      FROM jsonb_each(v_spec)
                LOOP
                    v_candidate_paths := ARRAY[]::text[];
                    IF jsonb_typeof(v_field_spec) = 'string' THEN
                        v_candidate_paths := ARRAY[v_field_spec #>> '{}'];
                    ELSIF jsonb_typeof(v_field_spec) = 'array' THEN
                        SELECT COALESCE(array_agg(elem), ARRAY[]::text[])
                          INTO v_candidate_paths
                          FROM jsonb_array_elements_text(v_field_spec) AS elem;
                    END IF;

                    v_field_val := NULL;
                    FOREACH v_path IN ARRAY v_candidate_paths LOOP
                        v_jsonpath := public.normalize_jsonpath(v_path);
                        BEGIN
                            IF v_jsonpath IS NULL THEN
                                v_field_val := NULL;
                            ELSE
                                v_field_val := jsonb_path_query_first(p_source, v_jsonpath::JSONPATH);
                            END IF;
                        EXCEPTION
                            WHEN OTHERS THEN
                                v_field_val := NULL;
                        END;

                        IF v_field_val IS NULL OR v_field_val = 'null'::jsonb THEN
                            v_field_val := NULL;
                        ELSE
                            EXIT;
                        END IF;
                    END LOOP;

                    IF v_field_val IS NULL THEN
                        v_field_val := 'null'::jsonb;
                    END IF;

                    v_object := jsonb_set(v_object, ARRAY[v_field_key], v_field_val, TRUE);
                END LOOP;
                v_result := jsonb_set(v_result, ARRAY[v_target], v_object, TRUE);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    RETURN p_source;
END;
$function$;

-- Dialog360 reply inbound mapping: support WhatsApp Cloud payload (entry/changes/value) + interactive replies.
INSERT INTO public.mapping_configs (
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  'webhook_inbound',
  'dialog360_reply::communication.reply',
  jsonb_build_object(
    'description', 'Dialog360 WhatsApp reply mapping (WhatsApp Cloud payload compatible)',
    'external_id_path', 'entry.0.changes.0.value.messages.0.id',
    'event_type_path', 'entry.0.changes.0.value.messages.0.type',
    'transforms', jsonb_build_object(
      'communication', jsonb_build_object(
        -- Sender phone number (wa_id / from)
        'recipient', jsonb_build_array(
          'entry.0.changes.0.value.contacts.0.wa_id',
          'entry.0.changes.0.value.messages.0.from',
          'contacts.0.wa_id',
          'messages.0.from'
        ),
        -- Correlation id is optional; when present, it should match outbound context id.
        'correlation_id', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.context.id',
          'messages.0.context.id'
        ),
        -- Message id is the unique WhatsApp message identifier.
        'message_id', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.id',
          'messages.0.id'
        ),
        -- Reply payload/text support both text + interactive (button/list).
        'reply_payload', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.button.payload',
          'entry.0.changes.0.value.messages.0.interactive.button_reply.id',
          'entry.0.changes.0.value.messages.0.interactive.list_reply.id',
          'messages.0.button.payload',
          'messages.0.interactive.button_reply.id',
          'messages.0.interactive.list_reply.id'
        ),
        'reply_text', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.text.body',
          'entry.0.changes.0.value.messages.0.interactive.button_reply.title',
          'entry.0.changes.0.value.messages.0.interactive.list_reply.title',
          'messages.0.text.body',
          'messages.0.interactive.button_reply.title',
          'messages.0.interactive.list_reply.title'
        ),
        'timestamp', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.timestamp',
          'messages.0.timestamp'
        ),
        'message_type', jsonb_build_array(
          'entry.0.changes.0.value.messages.0.type',
          'messages.0.type'
        )
      )
    )
  ),
  1,
  'Inbound mapping for Dialog360 reply callbacks (multi-path; supports text + interactive replies)'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    mapping_version = mapping_configs.mapping_version + 1,
    notes = EXCLUDED.notes,
    updated_at = now();

COMMIT;

