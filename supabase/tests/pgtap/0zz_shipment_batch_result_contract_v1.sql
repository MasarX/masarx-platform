-- pgTAP: registry-owned shipment batch result rendering contract
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_command_registry'
       AND is_active = TRUE
       AND schema #>> '{properties,commands,items,properties,execution,properties,result_contract,type}' = 'string'
  ),
  'ui_command_registry schema declares execution.result_contract as a string'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_command_registry'
       AND is_active = TRUE
       AND (
         schema #> '{properties,commands,items,properties,execution,properties,result_contract,enum}'
         @> '["batch_items_v1"]'::jsonb
       ) IS DISTINCT FROM TRUE
  ),
  'every active ui_command_registry schema allows batch_items_v1'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE command->>'key' = 'shipments.delete') AS delete_count,
          COUNT(*) FILTER (WHERE command->>'key' = 'shipments.reschedule') AS reschedule_count
        FROM jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS commands(command)
      ) command_counts ON TRUE
     WHERE s.category = 'ui_command_registry'
       AND (command_counts.delete_count <> 1 OR command_counts.reschedule_count <> 1)
  ),
  'every ui_command_registry scope retains exactly one shipment delete and reschedule command'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS commands(command)
     WHERE s.category = 'ui_command_registry'
       AND command->>'key' IN ('shipments.delete', 'shipments.reschedule')
       AND command #>> '{execution,result_contract}' IS DISTINCT FROM 'batch_items_v1'
  ),
  'every persisted shipment cohort command uses batch_items_v1'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS commands(command)
     WHERE s.category = 'ui_command_registry'
       AND command->>'key' IN ('shipments.delete', 'shipments.reschedule')
       AND command #>> '{execution,result_contract}' IS DISTINCT FROM 'batch_items_v1'
  ),
  'every cached shipment cohort command uses batch_items_v1'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS commands(command)
     WHERE s.category = 'ui_command_registry'
       AND command->>'key' = 'shipments.delete'
       AND (
         command #>> '{execution,rpc}' IS DISTINCT FROM 'ui_execute_shipment_batch_operation_v1'
         OR command #>> '{execution,params,operation}' IS DISTINCT FROM 'cancel'
         OR command #>> '{selection,mode}' IS DISTINCT FROM 'multi'
         OR command #>> '{execution,confirm,tone}' IS DISTINCT FROM 'danger'
       )
  ),
  'shipments.delete preserves its canonical execution, selection, and confirmation metadata'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'commands', '[]'::jsonb)) AS commands(command)
     WHERE s.category = 'ui_command_registry'
       AND command->>'key' = 'shipments.reschedule'
       AND (
         command #>> '{execution,rpc}' IS DISTINCT FROM 'ui_execute_shipment_batch_operation_v1'
         OR command #>> '{execution,params,operation}' IS DISTINCT FROM 'reschedule'
         OR command #>> '{selection,mode}' IS DISTINCT FROM 'multi'
         OR NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(command #> '{execution,input_schema,fields}', '[]'::jsonb)) AS fields(field)
            WHERE field->>'key' = 'slot_date'
              AND COALESCE((field->>'required')::BOOLEAN, FALSE) = TRUE
         )
       )
  ),
  'shipments.reschedule preserves its canonical execution, selection, and input metadata'
);

SELECT finish();

ROLLBACK;
