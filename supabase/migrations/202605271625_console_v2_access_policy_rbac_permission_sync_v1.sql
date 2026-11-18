-- Console V2 Access request review permission sync.
-- Keeps RBAC permission lookup rows aligned with the active access policy
-- capability catalog so request approvals can materialize grants without
-- hardcoded one-off seeds.

BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'rbac_permission',
  'RBAC permissions registry (stable keys) for RLS/RPC predicates',
  'security',
  'tier_1',
  TRUE
)
ON CONFLICT (category) DO NOTHING;

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
permission_definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'rbac_permission'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  pd.id,
  pc.value,
  initcap(replace(pc.value, '.', ' ')),
  'Access policy capability mirrored for RBAC grant materialization',
  10000 + row_number() OVER (ORDER BY pc.value),
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'console_v2_access_policy_rbac_permission_sync_v1',
    'settings_category', 'access_control_policy',
    'capability_key', pc.value
  )
FROM permission_definition pd
CROSS JOIN policy_capabilities pc
ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET status = 'active',
      description = COALESCE(NULLIF(public.lookup_values.description, ''), EXCLUDED.description),
      metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
      updated_at = now();

COMMIT;
