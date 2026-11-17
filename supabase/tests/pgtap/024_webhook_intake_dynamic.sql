BEGIN;

SELECT plan(9);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM settings
    WHERE category = 'webhook_intake'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'webhook_intake global settings row exists'
);

SELECT has_column('operation_templates', 'call_type', 'operation_templates has call_type column');

SELECT is(
  resolve_settings('webhook_intake', 'global', NULL)->>'entry_template_id',
  '77770000-0000-0000-0000-000000770001',
  'webhook_intake global entry template defaults to webhook_intake_v1'
);

SELECT results_eq(
  $$
    SELECT (workflow_intake_webhook(NULL, '{}'::jsonb, '{}'::text, '{}'::jsonb)->>'status')::INT
  $$,
  ARRAY[401],
  'workflow_intake_webhook returns 401 when token missing'
);

SELECT ok(
  (resolve_webhook_intake_defaults(NULL::uuid)->>'accepted_async_status')::INT > 0,
  'resolve_webhook_intake_defaults supplies accepted_async_status'
);

SELECT ok(
  (resolve_webhook_intake_defaults(NULL::uuid)->>'poll_attempts')::INT >= 1,
  'resolve_webhook_intake_defaults supplies poll_attempts >= 1'
);

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls(
    COALESCE(sv.value, '{}'::jsonb)
    || jsonb_build_object(
      'defaults',
      jsonb_build_object(
        'accepted_async_status', 291,
        'synchronous_success_status', 208,
        'bad_request_status', 498,
        'error_status', 599,
        'poll_attempts', 3,
        'poll_interval_ms', 25
      )
    )
  )
FROM global_scope g
WHERE sv.id = g.settings_version_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls(
      COALESCE(s.cached_value, '{}'::jsonb)
      || jsonb_build_object(
        'defaults',
        jsonb_build_object(
          'accepted_async_status', 291,
          'synchronous_success_status', 208,
          'bad_request_status', 498,
          'error_status', 599,
          'poll_attempts', 3,
          'poll_interval_ms', 25
        )
      )
    ),
    last_updated = now()
FROM global_scope g
WHERE s.id = g.settings_id;

SELECT is(
  resolve_webhook_intake_defaults(NULL::uuid)->>'error_status',
  '599',
  'resolve_webhook_intake_defaults reflects overridden error_status'
);

CREATE TEMP TABLE tmp_webhook_intake_source AS
WITH org AS (
    SELECT id FROM organizations ORDER BY created_at LIMIT 1
),
ids AS (
    SELECT gen_random_uuid() AS mapping_id, gen_random_uuid() AS source_id
),
mc AS (
    INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config)
    SELECT ids.mapping_id,
           'webhook_inbound',
           'pgtap-webhook-' || ids.mapping_id::text,
           '{}'::jsonb
    FROM ids
    RETURNING id
),
src AS (
    INSERT INTO webhook_sources (
        id,
        organization_id,
        source_identifier,
        name,
        provider_type,
        auth_token,
        mapping_config_id,
        sender_id,
        rate_limit_per_hour,
        enabled,
        created_at,
        updated_at
    )
    SELECT
        ids.source_id,
        org.id,
        'pgtap-source-' || ids.source_id::text,
        'pgTAP Source',
        'client',
        'pgtap-dynamic-token',
        ids.mapping_id,
        NULL,
        1000,
        true,
        now(),
        now()
    FROM org, ids
    RETURNING id, organization_id
)
SELECT id AS webhook_source_id, organization_id
FROM src;

CREATE TEMP TABLE tmp_webhook_intake_entry_template AS
SELECT resolve_settings('webhook_intake', 'global', NULL)->>'entry_template_id' AS entry_template_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls((COALESCE(sv.value, '{}'::jsonb) - 'entry_template_id'))
FROM global_scope g
WHERE sv.id = g.settings_version_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls((COALESCE(s.cached_value, '{}'::jsonb) - 'entry_template_id')),
    last_updated = now()
FROM global_scope g
WHERE s.id = g.settings_id;

SELECT is(
  (
    SELECT (workflow_intake_webhook('pgtap-dynamic-token', '{}'::jsonb, '{}'::text, '{}'::jsonb)->>'status')::INT
  ),
  599,
  'workflow_intake_webhook uses dynamic error_status when workflow template missing'
);

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
orig AS (
  SELECT entry_template_id
  FROM tmp_webhook_intake_entry_template
  LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls(
    (COALESCE(sv.value, '{}'::jsonb) - 'entry_template_id')
    || COALESCE(
        (
          SELECT CASE
                   WHEN entry_template_id IS NULL OR entry_template_id = ''
                     THEN NULL
                   ELSE jsonb_build_object('entry_template_id', entry_template_id)
                 END
          FROM orig
        ),
        '{}'::jsonb
      )
  )
FROM global_scope g
WHERE sv.id = g.settings_version_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
orig AS (
  SELECT entry_template_id
  FROM tmp_webhook_intake_entry_template
  LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls(
      (COALESCE(s.cached_value, '{}'::jsonb) - 'entry_template_id')
      || COALESCE(
          (
            SELECT CASE
                     WHEN entry_template_id IS NULL OR entry_template_id = ''
                       THEN NULL
                     ELSE jsonb_build_object('entry_template_id', entry_template_id)
                   END
            FROM orig
          ),
          '{}'::jsonb
        )
    ),
    last_updated = now()
FROM global_scope g
WHERE s.id = g.settings_id;

DO $$
DECLARE
  v_source UUID;
BEGIN
  SELECT webhook_source_id INTO v_source FROM tmp_webhook_intake_source LIMIT 1;
  PERFORM upsert_webhook_ingest_policy(
    'source',
    v_source,
    jsonb_build_object(
      'ack', jsonb_build_object(
        'mode', 'synchronous_success',
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'validation', jsonb_build_object(
        'hmac', jsonb_build_object(
          'enabled', true,
          'header', 'x-signature'
        )
      ),
      'logging', jsonb_build_object('decision_point', 'workflow_intake_response')
    )
  );
END;
$$;

SELECT is(
  (
    SELECT (
      workflow_intake_webhook(
        'pgtap-dynamic-token',
        jsonb_build_object('x-signature', 'invalid'),
        '{}'::text,
        '{}'::jsonb
      )->>'status'
    )::INT
  ),
  498,
  'HMAC failure returns dynamic bad_request_status'
);

SELECT * FROM finish();

ROLLBACK;
