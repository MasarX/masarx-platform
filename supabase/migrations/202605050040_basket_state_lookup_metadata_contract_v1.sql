-- Console V2 basket lifecycle metadata contract.
-- Basket KPIs and transition choices are row-driven from lookup_values.metadata;
-- keep the backend lookup rows aligned with the frontend seed catalog.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202605050040_basket_state_lookup_metadata_contract_v1'));

WITH state_contract(value, metadata_patch) AS (
  VALUES
    (
      'forming',
      '{"is_open":true,"is_terminal":false,"is_ready":false,"is_exception":false,"next_states":["ready","expired"]}'::jsonb
    ),
    (
      'ready',
      '{"is_open":true,"is_terminal":false,"is_ready":true,"is_exception":false,"next_states":["reserved","expired"]}'::jsonb
    ),
    (
      'reserved',
      '{"is_open":false,"is_terminal":false,"is_ready":false,"is_exception":false,"next_states":["dispatched","expired"]}'::jsonb
    ),
    (
      'dispatched',
      '{"is_open":false,"is_terminal":true,"is_ready":false,"is_exception":false,"next_states":[]}'::jsonb
    ),
    (
      'expired',
      '{"is_open":false,"is_terminal":true,"is_ready":false,"is_exception":true,"next_states":["forming"]}'::jsonb
    )
)
UPDATE public.lookup_values lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || state_contract.metadata_patch,
       updated_at = now()
  FROM public.lookup_definitions ld,
       state_contract
 WHERE lv.lookup_definition_id = ld.id
   AND ld.category = 'basket_state'
   AND lv.value = state_contract.value;

COMMIT;
