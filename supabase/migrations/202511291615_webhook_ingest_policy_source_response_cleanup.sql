-- Migration: webhook_ingest_policy source response.* cleanup
-- Purpose:
--   - Normalize source-scoped webhook_ingest_policy rows to use the ack.*
--     schema exclusively by removing legacy response.* keys, mirroring the
--     behavior of 202511111300_fix_webhook_ingest_policy_defaults.sql.

BEGIN;

WITH normalized AS (
  SELECT
    sv.id,
    sv.scope_type,
    sv.value,
    COALESCE(
      NULLIF(sv.value #>> '{ack,mode}', ''),
      NULLIF(sv.value #>> '{response,mode}', ''),
      'accepted_async'
    ) AS derived_mode,
    COALESCE(
      NULLIF(sv.value #>> '{ack,status_code}', '')::int,
      NULLIF(sv.value #>> '{response,status_code}', '')::int,
      CASE COALESCE(sv.value #>> '{response,mode}', sv.value #>> '{ack,mode}')
        WHEN 'synchronous_success' THEN 200
        ELSE 202
      END
    ) AS derived_status,
    COALESCE(
      sv.value #> '{ack,default_headers}',
      sv.value #> '{response,default_headers}',
      jsonb_build_object('content-type', 'application/json')
    ) AS derived_headers,
    NULLIF(sv.value #>> '{ack,reason_template}', '') AS derived_reason,
    NULLIF(sv.value #>> '{ack,default_outcome}', '') AS derived_outcome
  FROM settings_versions sv
  WHERE sv.category = 'webhook_ingest_policy'
    AND sv.scope_type = 'source'
    AND (sv.value ? 'response')
)
UPDATE settings_versions sv
SET value = jsonb_set(
              jsonb_set(
                (normalized.value - 'response'),
                '{ack}',
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'mode', to_jsonb(COALESCE(normalized.derived_mode, 'accepted_async')),
                    'status_code', to_jsonb(COALESCE(normalized.derived_status, 202)),
                    'default_headers', normalized.derived_headers,
                    'reason_template', to_jsonb(normalized.derived_reason),
                    'default_outcome', to_jsonb(normalized.derived_outcome)
                  )
                ),
                true
              ),
              '{schema}',
              COALESCE(
                normalized.value -> 'schema',
                jsonb_build_object('version', 'v1', 'registry', 'schema_registry')
              ),
              true
            )
FROM normalized
WHERE sv.id = normalized.id;

UPDATE settings s
SET cached_value = sv.value,
    last_updated = now()
FROM settings_versions sv
WHERE s.settings_version_id = sv.id
  AND s.category = 'webhook_ingest_policy';

COMMIT;

