BEGIN;

SELECT plan(8);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.value = 'hub'
      AND value.metadata->>'kpi_card_key' = 'hubs'
      AND value.metadata->>'kpi_card_tone' = 'info'
      AND value.status = 'active'
  ),
  'branch_type hub carries Console V2 KPI metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.value = 'depot'
      AND value.metadata->>'kpi_card_key' = 'depots'
      AND value.status = 'active'
  ),
  'branch_type depot carries Console V2 KPI metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.value = 'dropoff_point'
      AND value.metadata->>'kpi_card_key' = 'dropoffs'
      AND value.status = 'active'
  ),
  'branch_type dropoff_point carries Console V2 KPI metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.value = 'warehouse'
      AND value.label = 'Warehouse'
      AND value.metadata->>'kpi_card_key' = 'branches'
      AND value.status = 'active'
  ),
  'branch_type warehouse is an active lookup value'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.value = 'drop_off'
      AND value.status = 'active'
  ),
  0::bigint,
  'legacy branch_type drop_off is not active'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.label = 'Drop-off'
      AND value.status = 'active'
  ),
  1::bigint,
  'Console V2 branch type picker has one active Drop-off option'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.value = 'satellite'
      AND value.metadata->>'kpi_card_key' = 'branches'
      AND value.status = 'active'
  ),
  'branch_type satellite carries Console V2 KPI metadata'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values value
    JOIN public.lookup_definitions definition
      ON definition.id = value.lookup_definition_id
    WHERE definition.category = 'branch_type'
      AND value.value = 'counter'
      AND value.metadata->>'kpi_card_key' = 'dropoffs'
      AND value.status = 'active'
  ),
  'branch_type counter carries Console V2 KPI metadata'
);

SELECT * FROM finish();

ROLLBACK;
