-- Migration: Ops on-call WhatsApp auth hygiene
-- Purpose: Remove persisted auth headers and inject secrets at dispatch time for ops alerts.

BEGIN;

SET search_path TO public, extensions, pg_temp;

WITH target AS (
    SELECT
        ot.id,
        ot.request_mappings,
        ot.metadata
    FROM public.operation_templates ot
    JOIN public.providers p
      ON p.id = ot.provider_id
    WHERE p.name = 'dialog360_whatsapp'
      AND ot.operation_name = 'ops_oncall_whatsapp_alert_v1'
    ORDER BY ot.updated_at DESC
    LIMIT 1
)
UPDATE public.operation_templates ot
SET
    headers_template = jsonb_build_object('content-type', 'application/json'),
    request_mappings = jsonb_strip_nulls(
        COALESCE(target.request_mappings, '{}'::jsonb) - 'headers'
        || jsonb_build_object(
            'body',
            jsonb_strip_nulls(
                COALESCE(target.request_mappings->'body', '{}'::jsonb)
                || jsonb_build_object(
                    'to', COALESCE(target.request_mappings->'body'->>'to', '$.payload.to'),
                    'text.body', COALESCE(target.request_mappings->'body'->>'text.body', '$.payload.message')
                )
            )
        )
    ),
    metadata = jsonb_strip_nulls(
        COALESCE(target.metadata, '{}'::jsonb)
        || jsonb_build_object(
            'auth',
            jsonb_build_object(
                'mode', 'api_key_header',
                'auth_type', 'api_key',
                'header', 'D360-API-KEY',
                'credential_key', 'api_key'
            )
        )
    ),
    updated_at = now()
FROM target
WHERE ot.id = target.id;

COMMIT;
