-- Migration: Console V2 comms attempts read pack
-- Purpose:
--   The shipment supervision drawer reads communications attempts, but the
--   SSOT tables are service-role-only. Expose a scoped, redacted,
--   security-invoker projection and register it in ui_read_registry.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041720_console_v2_comms_attempts_read_pack_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_comms_attempt_directory
WITH (security_invoker = true)
AS
SELECT
  ca.id,
  oc.shipment_id,
  oc.target_id AS provider_id,
  ca.outbound_call_id,
  ca.attempt_number,
  ca.status,
  lower(regexp_replace(COALESCE(oc.call_type, ''), '^comms_', '')) AS channel,
  oc.context->>'template_id' AS template,
  ca.provider_message_id,
  ca.error_code,
  ca.error_message,
  ca.timestamp AS occurred_at,
  ca.created_at,
  ca.updated_at
FROM public.comms_attempts ca
JOIN public.outbound_calls oc
  ON oc.id = ca.outbound_call_id
WHERE public.is_platform_user()
   OR EXISTS (
     SELECT 1
     FROM public.shipments s
     WHERE s.id = oc.shipment_id
       AND (
         (public.current_user_scope_type() = 'tenant'
          AND s.organization_id = public.current_user_org_id())
         OR (public.current_user_scope_type() = 'client'
             AND s.client_id = public.current_user_scope_id())
         OR (public.current_user_scope_type() = 'sender'
             AND s.sender_id = public.current_user_scope_id())
       )
   );

COMMENT ON VIEW public.v_comms_attempt_directory IS
  'Scoped, redacted Console/Portal read projection for shipment communications attempts. Sources service-role-only comms_attempts/outbound_calls; exposes no headers/body payload secret material.';

REVOKE ALL ON public.v_comms_attempt_directory FROM PUBLIC;
REVOKE ALL ON public.v_comms_attempt_directory FROM anon;
GRANT SELECT ON public.v_comms_attempt_directory TO authenticated, service_role;

DO $do$
DECLARE
  v_resource JSONB := jsonb_build_object(
    'key', 'comms_attempts',
    'label', 'Comms attempts',
    'relation', 'public.v_comms_attempt_directory',
    'allow_view_relation', TRUE,
    'id_column', 'id',
    'scope_columns', jsonb_build_object('shipment', 'shipment_id'),
    'capability_read', 'shipments.read',
    'select', jsonb_build_array(
      'id',
      'shipment_id',
      'provider_id',
      'outbound_call_id',
      'attempt_number',
      'status',
      'channel',
      'template',
      'provider_message_id',
      'error_code',
      'error_message',
      'occurred_at',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'channel', 'column', 'channel', 'op', 'eq'),
      jsonb_build_object('key', 'provider_id', 'column', 'provider_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc')
  );
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_updated_resources JSONB;
  v_item JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  LOOP
    v_current := v_setting.value;
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    v_updated_resources := '[]'::jsonb;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resources)
    LOOP
      IF v_item->>'key' = 'comms_attempts' THEN
        v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      ELSE
        v_updated_resources := v_updated_resources || jsonb_build_array(v_item);
      END IF;
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
      WHERE item->>'key' = 'comms_attempts'
    ) THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Add Console V2 comms attempts read projection',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resource_map JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  LOOP
    v_current := v_setting.value;
    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    v_resource_map := jsonb_set(
      v_resource_map,
      '{comms_attempts}',
      jsonb_build_object('read', 'shipments.read'),
      TRUE
    );
    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Map Console V2 comms attempts read capability',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041720_console_v2_comms_attempts_read_pack_v1'));

COMMIT;
