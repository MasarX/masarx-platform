BEGIN;
SELECT plan(3);

SELECT has_table('public', 'lookup_values', 'lookup_values exists for RBAC permission registry');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value = 'settings_category_registry.read'
       AND COALESCE(lv.status, 'active') = 'active'
  ),
  'settings_category_registry.read is an active RBAC permission for Access request approval'
);

WITH latest_policy AS (
  SELECT DISTINCT ON (sv.scope_type, COALESCE(sv.scope_id, sv.scope_hash, '00000000-0000-0000-0000-000000000000'::uuid))
         sv.value
    FROM public.settings_versions sv
   WHERE sv.category = 'access_control_policy'
     AND sv.approved_at IS NOT NULL
     AND COALESCE(sv.effective_from, '-infinity'::timestamptz) <= now()
     AND COALESCE(sv.effective_until, 'infinity'::timestamptz) > now()
   ORDER BY sv.scope_type,
            COALESCE(sv.scope_id, sv.scope_hash, '00000000-0000-0000-0000-000000000000'::uuid),
            sv.version DESC,
            sv.created_at DESC
),
policy_capabilities AS (
  SELECT DISTINCT NULLIF(btrim(capability_key), '') AS value
    FROM latest_policy lp
   CROSS JOIN LATERAL (
     SELECT jsonb_array_elements_text(COALESCE(role_item->'capability_keys', '[]'::jsonb)) AS capability_key
       FROM jsonb_array_elements(COALESCE(lp.value->'roles', '[]'::jsonb)) role_item
     UNION
     SELECT capability_item->>'key' AS capability_key
       FROM jsonb_array_elements(COALESCE(lp.value->'capabilities', '[]'::jsonb)) capability_item
   ) caps
   WHERE NULLIF(btrim(capability_key), '') IS NOT NULL
     AND capability_key <> '*'
),
missing_permissions AS (
  SELECT pc.value
    FROM policy_capabilities pc
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.lookup_values lv
       JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
      WHERE ld.category = 'rbac_permission'
        AND lv.value = pc.value
        AND COALESCE(lv.status, 'active') = 'active'
   )
)
SELECT is(
  (SELECT count(*)::integer FROM missing_permissions),
  0,
  'all active access policy capabilities are mirrored into active RBAC permissions'
);

SELECT * FROM finish();
ROLLBACK;
