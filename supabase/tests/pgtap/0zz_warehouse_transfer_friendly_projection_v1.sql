-- pgTAP: Warehouse transfer friendly projection + registry contract.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE OR REPLACE FUNCTION pg_temp.test_warehouse_transfer_friendly_projection_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_registry JSONB := NULL;
BEGIN
  SELECT cached_value
    INTO v_registry
    FROM public.settings
   WHERE category = 'ui_read_registry'
     AND scope_type = 'global'
   LIMIT 1;

  RETURN NEXT has_view(
    'public',
    'warehouse_transfers_ui',
    'warehouse_transfers_ui projection exists'
  );
  RETURN NEXT ok(
    COALESCE(
      (SELECT reloptions @> ARRAY['security_invoker=true']
         FROM pg_class
        WHERE oid = 'public.warehouse_transfers_ui'::regclass),
      FALSE
    ),
    'warehouse_transfers_ui is a security_invoker view'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers'
        AND item.value->>'relation' = 'public.warehouse_transfers_ui'
    ),
    'warehouse_transfers registry reads from the friendly projection'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers'
        AND item.value->'select' ? 'display_id'
        AND item.value->'select' ? 'from_branch_name'
        AND item.value->'select' ? 'to_branch_name'
        AND item.value->'select' ? 'manifest_shipment_references'
    ),
    'warehouse_transfers registry selects friendly identifier, branch, and manifest labels'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_registry->'resources', '[]'::jsonb)) AS item(value)
      WHERE item.value->>'key' = 'warehouse_transfers'
        AND item.value#>>'{column_labels,from_branch_name}' = 'From branch'
        AND item.value#>>'{column_labels,to_branch_name}' = 'To branch'
        AND item.value#>>'{column_labels,manifest_shipment_references}' = 'Manifest shipments'
    ),
    'warehouse_transfers registry labels friendly projection columns'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'warehouse_transfers_ui'
        AND column_name IN (
          'display_id',
          'from_branch_name',
          'from_branch_reference',
          'to_branch_name',
          'to_branch_reference',
          'manifest_shipment_references'
        )
      GROUP BY table_schema, table_name
      HAVING COUNT(DISTINCT column_name) = 6
    ),
    'warehouse_transfers_ui exposes all friendly display columns'
  );

  RETURN;
END;
$function$;

SELECT * FROM pg_temp.test_warehouse_transfer_friendly_projection_v1();

SELECT * FROM finish();
ROLLBACK;
