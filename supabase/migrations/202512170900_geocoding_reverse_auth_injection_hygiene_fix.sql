-- Migration: Geocoding reverse auth injection + secret hygiene fix
-- Purpose:
--   - Ensure HERE reverse geocoding uses dispatch-time auth injection via operation_templates.metadata.auth
--   - Remove any apiKey/key params from stored url_query_mapping (no secrets in outbound_calls.url)
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - ZERO HARD CODING - SSOT
-- Date: 2025-12-17

BEGIN;

-- HERE forward: idempotently enforce auth metadata + remove apiKey from url_query_mapping
UPDATE public.operation_templates
SET metadata = jsonb_set(
  jsonb_strip_nulls(
    COALESCE(metadata, '{}'::jsonb)
    || jsonb_build_object(
      'operation_role', 'geocoding_forward',
      'auth', jsonb_build_object(
        'mode', 'api_key_query',
        'auth_type', 'api_key',
        'query_param', 'apiKey',
        'credential_key', 'api_key'
      )
    )
  ),
  '{url_query_mapping}',
  jsonb_build_array(
    jsonb_build_object('param', 'q', 'value_path', '$.address.text'),
    jsonb_build_object('param', 'lang', 'value_path', '$.address.lang'),
    jsonb_build_object('param', 'limit', 'value_path', '$.address.limit')
  ),
  TRUE
)
WHERE operation_name = 'geocoding_here_forward_v1';

-- HERE reverse: enforce auth metadata + remove apiKey from url_query_mapping
UPDATE public.operation_templates
SET metadata = jsonb_set(
  jsonb_strip_nulls(
    COALESCE(metadata, '{}'::jsonb)
    || jsonb_build_object(
      'operation_role', 'geocoding_reverse',
      'auth', jsonb_build_object(
        'mode', 'api_key_query',
        'auth_type', 'api_key',
        'query_param', 'apiKey',
        'credential_key', 'api_key'
      )
    )
  ),
  '{url_query_mapping}',
  jsonb_build_array(
    jsonb_build_object('param', 'at', 'value_path', '$.coordinates'),
    jsonb_build_object('param', 'lang', 'value_path', '$.address.lang'),
    jsonb_build_object('param', 'limit', 'value_path', '$.address.limit')
  ),
  TRUE
)
WHERE operation_name = 'geocoding_here_reverse_v1';

COMMIT;

