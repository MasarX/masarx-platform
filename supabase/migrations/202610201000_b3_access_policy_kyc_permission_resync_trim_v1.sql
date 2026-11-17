-- Console V2 access policy RBAC permission resync for Mobile V2 KYC.
-- Keeps access-control capabilities mirrored into the RBAC permission registry
-- after Mobile V2 onboarding navigation introduced kyc.write.

-- Forward resync: exclude trimmed wildcard keys without changing applied migration history.
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
     AND btrim(capability_key) <> '*'
),
fixed_capabilities AS (
  SELECT *
    FROM (VALUES
      (
        'kyc.write',
        'KYC Write',
        'Create and update Mobile V2 onboarding and compliance KYC artifacts.'
      ),
      (
        'settings_category_registry.read',
        'Settings Category Registry Read',
        'Read settings category registry entries during access request approval.'
      )
    ) AS v(value, label, description)
),
permission_rows AS (
  SELECT
    pc.value,
    initcap(replace(pc.value, '.', ' ')) AS label,
    'Access policy capability mirrored for RBAC grant materialization' AS description,
    jsonb_build_object(
      'source', 'access_policy_kyc_permission_resync_v1',
      'settings_category', 'access_control_policy',
      'capability_key', pc.value
    ) AS metadata
  FROM policy_capabilities pc
  UNION
  SELECT
    fc.value,
    fc.label,
    fc.description,
    jsonb_build_object(
      'source', 'access_policy_kyc_permission_resync_v1',
      'settings_category', CASE
        WHEN fc.value = 'settings_category_registry.read' THEN 'settings_category_registry'
        ELSE 'access_control_policy'
      END,
      'capability_key', fc.value
    ) AS metadata
  FROM fixed_capabilities fc
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
  pr.value,
  pr.label,
  pr.description,
  10000 + row_number() OVER (ORDER BY pr.value),
  FALSE,
  'active',
  pr.metadata
FROM permission_definition pd
CROSS JOIN (
  SELECT DISTINCT ON (value)
         value,
         label,
         description,
         metadata
    FROM permission_rows
   ORDER BY value
) pr
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = COALESCE(NULLIF(public.lookup_values.label, ''), EXCLUDED.label),
       description = COALESCE(NULLIF(public.lookup_values.description, ''), EXCLUDED.description),
       status = 'active',
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now();

COMMIT;
