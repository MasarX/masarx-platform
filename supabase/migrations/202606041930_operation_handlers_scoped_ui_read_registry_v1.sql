-- Migration: Operation handlers scoped UI read registry
-- Purpose: expose the global workflow handler catalog through an explicit scoped projection.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606041930_operation_handlers_scoped_ui_read_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_operation_handler_directory
WITH (security_invoker = true) AS
SELECT
  public.current_user_org_id() AS organization_id,
  CASE
    WHEN public.current_user_scope_type() = 'client' THEN public.current_user_scope_id()
    WHEN public.current_user_scope_type() = 'sender' THEN (
      SELECT s.client_id
        FROM public.senders s
       WHERE s.id = public.current_user_scope_id()
       LIMIT 1
    )
    ELSE NULL::uuid
  END AS client_id,
  CASE
    WHEN public.current_user_scope_type() = 'sender' THEN public.current_user_scope_id()
    ELSE NULL::uuid
  END AS sender_id,
  oh.handler_key,
  oh.handler_schema,
  oh.handler_name,
  oh.handler_signature,
  oh.handler_version,
  oh.is_active,
  oh.created_by,
  oh.created_at,
  oh.updated_at,
  oh.notes,
  oh.doc_url,
  oh.ui_label,
  oh.ui_category,
  oh.ui_description,
  oh.config_schema_category
FROM public.operation_handlers oh;

COMMENT ON VIEW public.v_operation_handler_directory IS
  'Scoped Console V2 projection for the global workflow operation handler catalog.';

GRANT SELECT ON public.v_operation_handler_directory TO authenticated, service_role;

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);

    SELECT COALESCE(
             jsonb_agg(
               CASE
                 WHEN resource->>'key' = 'operation_handlers' THEN
                   resource
                   || jsonb_build_object(
                        'relation', 'public.v_operation_handler_directory',
                        'write_relation', 'public.operation_handlers',
                        'scope_columns', jsonb_build_object(
                          'tenant', 'organization_id',
                          'client', 'client_id',
                          'sender', 'sender_id'
                        )
                      )
                 ELSE resource
               END
               ORDER BY ordinality
             ),
             '[]'::jsonb
           )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
           WITH ORDINALITY AS r(resource, ordinality);

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Console V2: scope operation handler catalog reads',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_setting.settings_version_id
       AND sv.value IS DISTINCT FROM v_next;

    UPDATE public.settings s
       SET cached_value = v_next,
           last_updated = now()
     WHERE s.id = v_setting.setting_id
       AND s.cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%operation_handlers%';
END;
$registry$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'v_operation_handler_directory'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'v_operation_handler_directory must be a security_invoker view';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'operation_handlers'
            AND (
              resource->>'relation' <> 'public.v_operation_handler_directory'
              OR resource->>'write_relation' <> 'public.operation_handlers'
              OR resource#>>'{scope_columns,tenant}' <> 'organization_id'
              OR resource#>>'{scope_columns,client}' <> 'client_id'
              OR resource#>>'{scope_columns,sender}' <> 'sender_id'
            )
       )
  ) THEN
    RAISE EXCEPTION 'operation_handlers registry entries are missing scoped catalog metadata';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202606041930_operation_handlers_scoped_ui_read_registry_v1'));

COMMIT;
