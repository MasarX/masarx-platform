-- Console V2 customer projection registry repair.
--
-- Console V2 customer setup screens read summary/directory projections for
-- first-tenant onboarding context. Register those projections in every
-- ui_read_registry settings row so live Console reads do not fall back to seed
-- data and platform operators can filter by the active tenant lens.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605061230_console_v2_customer_projection_registry_all_scopes_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER VIEW IF EXISTS public.v_client_summary SET (security_invoker = true);
ALTER VIEW IF EXISTS public.v_sender_summary SET (security_invoker = true);
ALTER VIEW IF EXISTS public.v_recipient_directory SET (security_invoker = true);

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB;
  v_customer_resources JSONB[] := ARRAY[
    jsonb_build_object(
      'key', 'client_summary',
      'label', 'Client summary',
      'relation', 'public.v_client_summary',
      'allow_view_relation', TRUE,
      'id_column', 'client_id',
      'capability_read', 'clients.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id'),
      'select', jsonb_build_array(
        'client_id', 'id', 'organization_id', 'name', 'slug', 'sla_tier', 'status',
        'sender_count', 'recipient_count', 'active_shipments', 'total_shipments',
        'last_shipment_at', 'contract_active', 'has_warehouse'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc')
    ),
    jsonb_build_object(
      'key', 'sender_summary',
      'label', 'Sender summary',
      'relation', 'public.v_sender_summary',
      'allow_view_relation', TRUE,
      'id_column', 'sender_id',
      'capability_read', 'senders.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id_resolved', 'client', 'client_id'),
      'select', jsonb_build_array(
        'sender_id', 'id', 'client_id', 'organization_id_resolved', 'name', 'brand_name',
        'client_label', 'client_slug', 'sla_tier_inherited', 'status', 'active_shipments',
        'total_shipments', 'last_shipment_at', 'effective_warehouse_id', 'has_warehouse',
        'updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'organization_id_resolved', 'column', 'organization_id_resolved', 'op', 'eq'),
        jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
        jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc')
    ),
    jsonb_build_object(
      'key', 'recipient_directory',
      'label', 'Recipient directory',
      'relation', 'public.v_recipient_directory',
      'allow_view_relation', TRUE,
      'id_column', 'recipient_id',
      'capability_read', 'recipients.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
      'select', jsonb_build_array(
        'recipient_id', 'id', 'organization_id', 'client_id', 'name', 'phone_number',
        'phone_validation_status', 'email', 'preferred_language', 'preferred_comm_channel',
        'client_label', 'client_slug', 'total_shipments', 'last_shipment_at',
        'last_shipment_status', 'phone_validated', 'has_quiet_hours', 'updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
        jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike'),
        jsonb_build_object('key', 'phone_number', 'column', 'phone_number', 'op', 'ilike'),
        jsonb_build_object('key', 'email', 'column', 'email', 'op', 'ilike')
      ),
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc')
    )
  ];
BEGIN
  FOR v_setting IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    FOREACH v_resource IN ARRAY v_customer_resources
    LOOP
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_filtered
        FROM jsonb_array_elements(v_resources) AS value
       WHERE value->>'key' <> v_resource->>'key';

      v_resources := v_filtered || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_setting.version + 1,
             change_reason = 'Add Console V2 customer projection resources to ui_read_registry',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_setting.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_setting.settings_id;
    END IF;
  END LOOP;
END $do$;

SELECT pg_advisory_unlock(hashtext('202605061230_console_v2_customer_projection_registry_all_scopes_v1'));

COMMIT;
