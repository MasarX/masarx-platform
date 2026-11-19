BEGIN;
SELECT plan(8);

SELECT is(
  (
    SELECT lv.metadata #>> '{console_context,required,0,payload_key}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'driver_shift'
  ),
  'subject_id',
  'driver_shift requires a subject_id from Console'
);

SELECT is(
  (
    SELECT lv.metadata #>> '{console_context,required,0,subject_type}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'driver_shift'
  ),
  'driver',
  'driver_shift records subject_type=driver'
);

SELECT is(
  (
    SELECT lv.metadata #>> '{console_context,required,0,resource}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'driver_shift'
  ),
  'drivers',
  'driver_shift resolves options from drivers'
);

SELECT is(
  (
    SELECT lv.metadata #>> '{console_context,required,0,payload_key}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'branch_day'
  ),
  'branch_id',
  'branch_day requires branch_id from Console'
);

SELECT is(
  (
    SELECT lv.metadata #>> '{console_context,required,0,resource}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'branch_day'
  ),
  'branches',
  'branch_day resolves options from branches'
);

SELECT is(
  (
    SELECT lv.metadata #>> '{console_context,required,0,payload_key}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'client_cycle'
  ),
  'client_id',
  'client_cycle requires client_id from Console'
);

SELECT is(
  (
    SELECT lv.metadata #>> '{console_context,required,0,resource}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'client_cycle'
  ),
  'clients',
  'client_cycle resolves options from clients'
);

SELECT isnt(
  NULLIF((
    SELECT lv.metadata #>> '{console_context,unsupported_message}'
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'settlement_scope_type'
      AND lv.value = 'marketplace_contract'
  ), ''),
  NULL,
  'marketplace_contract is blocked unless opened from the owning contract workflow'
);

SELECT * FROM finish();
ROLLBACK;
