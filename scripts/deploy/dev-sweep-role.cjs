function ensureTenantRole(query, organizationId, key, capabilities) {
  // Add the role only to the synthetic tenant and preserve inherited policy.
  return query(`
    WITH role_patch AS (
      SELECT COALESCE(scoped.cached_value, '{}'::jsonb)
          || CASE WHEN scoped.cached_value ? 'roles' THEN '{}'::jsonb
                  ELSE '{"roles__merge_strategy":"append"}'::jsonb END
          || jsonb_build_object('roles', COALESCE(scoped.cached_value->'roles', '[]'::jsonb) || $2::jsonb) AS value,
        inherited.schema_version
      FROM public.resolve_access_control_policy_v1('tenant', $1::uuid, false) AS effective
      JOIN public.settings_versions inherited ON inherited.id = effective.settings_version_id
      LEFT JOIN public.settings scoped ON scoped.category = 'access_control_policy'
        AND scoped.scope_type = 'tenant' AND scoped.scope_id = $1::uuid
      WHERE jsonb_typeof(effective.policy->'roles') = 'array'
        AND COALESCE(jsonb_typeof(scoped.cached_value), 'object') = 'object'
        AND COALESCE(jsonb_typeof(scoped.cached_value->'roles'), 'array') = 'array'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(effective.policy->'roles') AS existing
          WHERE existing->>'key' = $3
        )
    )
    SELECT saved.settings_id FROM role_patch
    CROSS JOIN LATERAL public.upsert_settings_value_v1(
      'access_control_policy', 'tenant', $1::uuid, role_patch.value,
      role_patch.schema_version, 'Provision synthetic DEV sweep reader'
    ) AS saved`, [organizationId, JSON.stringify([{ key, capability_keys: capabilities }]), key], 'tenant_role_write');
}

module.exports = { ensureTenantRole };
