-- Migration: Alert dispatch policy (row-driven) + provenance
-- Purpose:
--   - Make dispatch_alert_trigger routing (auth + recipients) settings-driven (no hardcoded fallbacks).
--   - Preserve existing per-rule overrides via alert_rules.message_variables.dispatch.
--   - Record settings resolution provenance on dispatch decisions.
-- Date: 2025-12-14

BEGIN;

-------------------------------------------------------------------------------
-- 1) Schema: alert_dispatch_policy
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'alert_dispatch_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'channels', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'comms_whatsapp', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'auth_config_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
              'recipients', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
              'inherit_auth_config_from_comms_reply_policy', jsonb_build_object('type', 'boolean'),
              'use_provider_default_recipient_when_missing', jsonb_build_object('type', 'boolean')
            )
          )
        )
      )
    )
  ),
  'Alert dispatch routing policy (auth + recipients) resolved via the canonical settings ladder.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'channels', jsonb_build_object(
        'comms_whatsapp', jsonb_build_object(
          'inherit_auth_config_from_comms_reply_policy', true,
          'use_provider_default_recipient_when_missing', true
        )
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-------------------------------------------------------------------------------
-- 2) Seed: global default policy (no secrets; behaviour remains row-driven)
-------------------------------------------------------------------------------

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'channels', jsonb_build_object(
      'comms_whatsapp', jsonb_build_object(
        'inherit_auth_config_from_comms_reply_policy', TRUE,
        'use_provider_default_recipient_when_missing', TRUE
      )
    )
  ) AS value
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    'alert_dispatch_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global alert_dispatch_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'alert_dispatch_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'alert_dispatch_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Dispatch: replace hardcoded routing with settings-driven policy
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_alert_trigger(p_trigger_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_trigger RECORD;
  v_rule RECORD;
  v_channel TEXT;

  -- Per-rule overrides (highest precedence)
  v_dispatch_auth UUID;
  v_recipients JSONB;

  -- Policy-driven defaults (ladder)
  v_policy_ctx JSONB;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_channel_cfg JSONB := '{}'::jsonb;
  v_settings_resolution_id UUID := NULL;

  v_inherit_auth BOOLEAN := FALSE;
  v_use_provider_default BOOLEAN := FALSE;
  v_provider_id UUID := NULL;
  v_default_recipient TEXT := NULL;

  v_recipient TEXT;
  v_enqueued INT := 0;
  v_result JSONB;
BEGIN
  SELECT * INTO v_trigger FROM public.alert_triggers WHERE id = p_trigger_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing', 'reason', 'trigger_not_found');
  END IF;

  IF v_trigger.notified_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'already_notified');
  END IF;

  SELECT * INTO v_rule FROM public.alert_rules WHERE id = v_trigger.alert_rule_id;
  IF NOT FOUND THEN
    UPDATE public.alert_triggers
       SET notified_at = now(),
           resolution_notes = COALESCE(resolution_notes, 'dispatch_skipped_missing_rule')
     WHERE id = v_trigger.id;
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'rule_not_found');
  END IF;

  v_dispatch_auth := NULLIF(v_rule.message_variables #>> '{dispatch,auth_config_id}', '')::UUID;
  v_recipients := v_rule.message_variables #> '{dispatch,recipients}';

  -- Resolve alert_dispatch_policy via ladder using org context.
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object('organization_id', v_trigger.organization_id));
  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context('alert_dispatch_policy', v_policy_ctx)
    LIMIT 1;

  IF FOUND AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
    v_channel_cfg := COALESCE(v_policy->'channels'->'comms_whatsapp', '{}'::jsonb);

    -- Provenance (log once per dispatch attempt).
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_trigger.organization_id,
      p_category := 'alert_dispatch_policy',
      p_winning_scope_type := v_policy_row.scope_type,
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := v_policy_row.version,
      p_scope_path := v_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'alert_trigger_id', v_trigger.id,
        'alert_rule_id', v_rule.id,
        'channels', v_rule.alert_channels
      )),
      p_merge_notes := NULL
    );
  END IF;

  -- Policy defaults: auth + recipients (applied only when rule overrides are absent).
  v_inherit_auth := COALESCE(NULLIF(v_channel_cfg->>'inherit_auth_config_from_comms_reply_policy', '')::BOOLEAN, FALSE);
  v_use_provider_default := COALESCE(NULLIF(v_channel_cfg->>'use_provider_default_recipient_when_missing', '')::BOOLEAN, FALSE);

  IF v_dispatch_auth IS NULL THEN
    BEGIN
      v_dispatch_auth := NULLIF(v_channel_cfg->>'auth_config_id', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_dispatch_auth := NULL;
    END;
  END IF;

  IF v_dispatch_auth IS NULL AND v_inherit_auth THEN
    DECLARE
      v_reply_row RECORD;
    BEGIN
      SELECT *
        INTO v_reply_row
        FROM public.resolve_settings_row('comms_reply_policy', 'tenant', v_trigger.organization_id)
        LIMIT 1;
      IF FOUND AND v_reply_row.value IS NOT NULL THEN
        v_dispatch_auth := NULLIF(v_reply_row.value->>'auth_config_id', '')::UUID;
      END IF;
    END;
  END IF;

  IF v_recipients IS NULL OR jsonb_typeof(v_recipients) <> 'array' OR jsonb_array_length(v_recipients) = 0 THEN
    v_recipients := v_channel_cfg->'recipients';
  END IF;

  IF (v_recipients IS NULL OR jsonb_typeof(v_recipients) <> 'array' OR jsonb_array_length(v_recipients) = 0)
     AND v_use_provider_default
     AND v_dispatch_auth IS NOT NULL THEN
    SELECT provider_id INTO v_provider_id FROM public.provider_auth_configs WHERE id = v_dispatch_auth;
    IF v_provider_id IS NOT NULL THEN
      SELECT NULLIF(cached_value->>'default_recipient', '')
        INTO v_default_recipient
        FROM public.settings
       WHERE category = 'provider_defaults'
         AND scope_type = 'resource'
         AND scope_id = v_provider_id
       ORDER BY last_updated DESC NULLS LAST
       LIMIT 1;
    END IF;
    IF v_default_recipient IS NOT NULL THEN
      v_recipients := jsonb_build_array(v_default_recipient);
    END IF;
  END IF;

  -- Dispatch: WhatsApp (enqueue-only; no direct network calls).
  FOR v_channel IN
    SELECT jsonb_array_elements_text(COALESCE(v_rule.alert_channels, '[]'::jsonb))
  LOOP
    IF v_channel <> 'comms_whatsapp' THEN
      CONTINUE;
    END IF;

    IF v_dispatch_auth IS NULL THEN
      CONTINUE;
    END IF;

    IF v_recipients IS NULL OR jsonb_typeof(v_recipients) <> 'array' OR jsonb_array_length(v_recipients) = 0 THEN
      CONTINUE;
    END IF;

    FOR v_recipient IN
      SELECT jsonb_array_elements_text(v_recipients)
    LOOP
      BEGIN
        PERFORM public.enqueue_comms_whatsapp(
          v_dispatch_auth,
          v_recipient,
          v_trigger.message,
          v_trigger.id,
          NULL,
          jsonb_strip_nulls(jsonb_build_object(
            'source', 'dispatch_alert_trigger',
            'organization_id', v_trigger.organization_id,
            'alert_trigger_id', v_trigger.id,
            'alert_rule_id', v_rule.id,
            'severity', v_trigger.severity
          ))
        );
        v_enqueued := v_enqueued + 1;
      EXCEPTION
        WHEN others THEN
          CONTINUE;
      END;
    END LOOP;
  END LOOP;

  IF v_enqueued > 0 THEN
    UPDATE public.alert_triggers
       SET notified_at = now()
     WHERE id = v_trigger.id;
    v_result := jsonb_build_object('status', 'dispatched', 'enqueued', v_enqueued);
  ELSE
    UPDATE public.alert_triggers
       SET notified_at = now(),
           resolution_notes = COALESCE(resolution_notes, 'dispatch_skipped_missing_config')
     WHERE id = v_trigger.id;
    v_result := jsonb_build_object('status', 'skipped', 'reason', 'no_dispatch_targets');
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_trigger.organization_id,
    p_decision_category := 'alert_dispatch',
    p_resource_type := 'alert_trigger',
    p_resource_id := v_trigger.id,
    p_decision_point := 'dispatch',
    p_decision_outcome := v_result->>'status',
    p_performed_by_system := 'alert_dispatch_worker',
    p_correlation_id := v_trigger.id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object('enqueued', v_enqueued)),
    p_decision_reason := COALESCE(v_result->>'reason', NULL),
    p_settings_resolution_id := v_settings_resolution_id
  );

  RETURN v_result;
END;
$$;

COMMIT;

