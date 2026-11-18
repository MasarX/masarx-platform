-- Basket policy request capability alignment.
--
-- Basket policy configuration belongs to the operations basket domain. Keep the
-- generic settings workbench on settings permissions, but allow the Basket
-- policy domain workbench to submit governed basket_policy changes with the
-- existing baskets.write capability.

BEGIN;
SELECT pg_advisory_lock(hashtext('202608161710_basket_policy_request_capability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  request_capability
)
VALUES (
  'basket_policy',
  'Policy-driven rules for grouping shipments into baskets through the workflow-owned basket assignment path.',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global","tenant","client","sender"]'::jsonb,
  'baskets.write'
)
ON CONFLICT (category) DO UPDATE
   SET description = COALESCE(NULLIF(public.settings_category_registry.description, ''), EXCLUDED.description),
       requires_schema = TRUE,
       requires_global_default = TRUE,
       side_effecting = TRUE,
       safe_missing_behavior = CASE
         WHEN public.settings_category_registry.safe_missing_behavior IN ('return_null', 'skip', 'skip_with_ack')
           THEN 'hard_fail'
         ELSE public.settings_category_registry.safe_missing_behavior
       END,
       allowed_scopes = EXCLUDED.allowed_scopes,
       request_capability = 'baskets.write',
       updated_at = now();

SELECT pg_advisory_unlock(hashtext('202608161710_basket_policy_request_capability_v1'));
COMMIT;
