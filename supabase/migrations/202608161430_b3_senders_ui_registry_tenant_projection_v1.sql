-- Bind the canonical senders UI resource to the tenant-resolved sender view.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607142000_b11_senders_ui_read_registry_tenant_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_sender_summary
WITH (security_invoker = true) AS
WITH ship_active AS (
  SELECT
    sh.sender_id,
    COUNT(*)::INT AS active_shipments
  FROM public.shipments sh
  WHERE sh.sender_id IS NOT NULL
    AND sh.status NOT IN ('delivered', 'cancelled', 'returned_to_sender')
  GROUP BY sh.sender_id
),
ship_total AS (
  SELECT
    sh.sender_id,
    COUNT(*)::INT AS total_shipments,
    MAX(sh.created_at) AS last_shipment_at
  FROM public.shipments sh
  WHERE sh.sender_id IS NOT NULL
  GROUP BY sh.sender_id
)
SELECT
  s.id              AS sender_id,
  s.id              AS id,
  s.client_id,
  s.name,
  s.brand_name,
  s.auto_provisioned,
  s.auto_recreate,
  s.warehouse_address_id,
  s.settings_override,
  s.status,
  s.updated_at,
  c.name            AS client_label,
  c.slug            AS client_slug,
  c.sla_tier        AS sla_tier_inherited,
  c.organization_id AS organization_id_resolved,
  COALESCE(s.warehouse_address_id, c.warehouse_address_id) AS effective_warehouse_id,
  (s.warehouse_address_id IS NOT NULL) AS has_warehouse,
  COALESCE(ship_active.active_shipments, 0) AS active_shipments,
  COALESCE(ship_total.total_shipments, 0)   AS total_shipments,
  ship_total.last_shipment_at,
  s.created_at
FROM public.senders s
LEFT JOIN public.clients c ON c.id = s.client_id
LEFT JOIN ship_active ON ship_active.sender_id = s.id
LEFT JOIN ship_total  ON ship_total.sender_id = s.id;

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_sender_resource CONSTANT JSONB := jsonb_build_object(
    'key', 'senders',
    'label', 'Senders',
    'relation', 'public.v_sender_summary',
    'allow_view_relation', TRUE,
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id_resolved',
      'client', 'client_id',
      'sender', 'id'
    ),
    'capability_read', 'senders.read',
    'select', jsonb_build_array('id', 'client_id', 'name', 'brand_name', 'status', 'auto_provisioned', 'created_at'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
  );
BEGIN
  FOR v_setting IN
    SELECT
      s.id AS setting_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := v_setting.value;

    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_current->'resources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_read_registry settings % has an invalid resources payload', v_setting.setting_id;
    END IF;

    SELECT COALESCE(
             jsonb_agg(resource ORDER BY ordinality)
               FILTER (WHERE resource->>'key' IS DISTINCT FROM 'senders'),
             '[]'::jsonb
           ) || jsonb_build_array(v_sender_resource)
      INTO v_resources
      FROM jsonb_array_elements(v_current->'resources')
           WITH ORDINALITY AS r(resource, ordinality);

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Scope senders UI reads through the tenant-resolved sender projection',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%senders%';
END;
$registry$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'v_sender_summary'
      AND c.relkind = 'v'
      AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'public.v_sender_summary must remain a security_invoker view';
  END IF;

  IF (
    SELECT array_agg(column_name::text ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v_sender_summary'
  ) IS DISTINCT FROM ARRAY[
    'sender_id', 'id', 'client_id', 'name', 'brand_name',
    'auto_provisioned', 'auto_recreate', 'warehouse_address_id',
    'settings_override', 'status', 'updated_at', 'client_label',
    'client_slug', 'sla_tier_inherited', 'organization_id_resolved',
    'effective_warehouse_id', 'has_warehouse', 'active_shipments',
    'total_shipments', 'last_shipment_at', 'created_at'
  ]::text[] THEN
    RAISE EXCEPTION 'public.v_sender_summary column identity drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL (
      VALUES (sv.value), (s.cached_value)
    ) AS payload(value)
    WHERE s.category = 'ui_read_registry'
      AND (
        (SELECT COUNT(*)
           FROM jsonb_array_elements(COALESCE(payload.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'senders') <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(payload.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'senders'
            AND resource->>'relation' = 'public.v_sender_summary'
            AND resource->>'allow_view_relation' = 'true'
            AND resource->'select' = '["id","client_id","name","brand_name","status","auto_provisioned","created_at"]'::jsonb
            AND resource->'default_sort' = '{"column":"created_at","direction":"desc"}'::jsonb
            AND resource->'scope_columns' = '{"tenant":"organization_id_resolved","client":"client_id","sender":"id"}'::jsonb
        )
      )
  ) THEN
    RAISE EXCEPTION 'senders ui_read_registry contract is not exact in every current settings payload';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202607142000_b11_senders_ui_read_registry_tenant_projection_v1'));

COMMIT;
