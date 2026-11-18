BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SELECT is(
  (SELECT request_capability FROM public.settings_category_registry WHERE category = 'basket_policy'),
  'baskets.write',
  'basket_policy settings requests are gated by baskets.write'
);

SELECT is(
  (SELECT allowed_scopes FROM public.settings_category_registry WHERE category = 'basket_policy'),
  '["global", "tenant", "client", "sender"]'::jsonb,
  'basket_policy settings requests are scoped to global, tenant, client, and sender'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry scr
      JOIN public.schema_registry sr
        ON sr.category = scr.category
       AND sr.is_active
     WHERE scr.category = 'basket_policy'
       AND scr.requires_schema
       AND scr.request_capability = 'baskets.write'
  ),
  'basket_policy request capability remains tied to an active schema'
);

SELECT * FROM finish();
ROLLBACK;
