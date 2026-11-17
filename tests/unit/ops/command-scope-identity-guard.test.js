const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const migration = fs.readFileSync(
  path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202608161610_b3_command_scope_identity_guard_v1.sql',
  ),
  'utf8',
);
const pgtap = fs.readFileSync(
  path.join(
    repoRoot,
    'supabase',
    'tests',
    'pgtap',
    '0zz_b17_command_scope_identity_guard_v1.sql',
  ),
  'utf8',
);
const apiSource = fs.readFileSync(
  path.join(repoRoot, 'packages', 'api', 'src', 'index.ts'),
  'utf8',
);
const sharedAppLayout = fs.readFileSync(
  path.join(repoRoot, 'apps', 'shared', 'app-layout.tsx'),
  'utf8',
);
const fieldOpsApp = fs.readFileSync(
  path.join(repoRoot, 'apps', 'fieldops', 'App.tsx'),
  'utf8',
);

describe('Command scope identity guard', () => {
  test('separates effective policy scope from nullable frontend identity scope', () => {
    expect(migration).toContain('v_policy_scope_id := public.current_user_scope_id();');
    expect(migration).toContain("WHEN v_scope_type IN ('platform', 'tenant') THEN NULL");
    expect(migration).toContain('ELSE v_user.access_scope_id');
    expect(migration).toContain(
      'FROM public.resolve_access_control_policy_v1(v_scope_type, v_policy_scope_id, TRUE)',
    );
    expect(migration).toContain("'scope_id', v_identity_scope_id");
    expect(migration).not.toContain("'scope_id', v_policy_scope_id");
  });

  test('keeps identity hydration fail closed and side-effect free', () => {
    expect(migration).toContain('ui_me_v1 requires a Console user profile');
    expect(migration).toContain("lower(COALESCE(v_user.status, '')) <> 'active'");
    expect(migration).toContain('ui_me_v1 requires an active Console user profile');
    expect(migration).toContain('ui_me_v1 requires an organization profile');
    expect(migration).not.toContain('tenant_user_invite_accept_v1');
  });

  test('locks every supported scope and public/api parity into the database matrix', () => {
    expect(pgtap).toContain('SELECT api.ui_me_v1() INTO v_api_me;');
    expect(pgtap).toContain('SELECT public.ui_me_v1() INTO v_public_me;');
    expect(pgtap).toContain('tenant policy scope resolves to organization id');
    expect(pgtap).toContain('platform super admin resolves global wildcard capability');
    expect(pgtap).toContain('client frontend identity returns the exact stored scope id');
    expect(pgtap).toContain('sender frontend identity returns the exact stored scope id');
    expect(pgtap).toContain('tenant api.ui_me_v1 matches stable public identity contract fields');
    expect(pgtap).toContain('platform api.ui_me_v1 matches stable public identity contract fields');
    expect(pgtap).toContain('client api.ui_me_v1 matches stable public identity contract fields');
    expect(pgtap).toContain('sender api.ui_me_v1 matches stable public identity contract fields');
    expect(pgtap.match(/v_api_me - 'settings_resolution_id'/g)).toHaveLength(4);
    expect(pgtap.match(/v_public_me - 'settings_resolution_id'/g)).toHaveLength(4);
  });

  test('proves invited, inactive, and suspended identities stay unchanged and fail closed', () => {
    for (const status of ['invited', 'inactive', 'suspended']) {
      expect(pgtap).toContain(`public.ui_me_v1 fails closed for ${status} users`);
      expect(pgtap).toContain(`api.ui_me_v1 fails closed for ${status} users`);
    }
    expect(pgtap).toContain('identity hydration does not activate invited users');
    expect(pgtap).toContain('identity hydration leaves inactive users unchanged');
    expect(pgtap).toContain('identity hydration leaves suspended users unchanged');
  });

  test('keeps nullable identity scope compatible with shared Console/Portal and FieldOps consumers', () => {
    expect(apiSource).toMatch(/export type UiScope = \{[\s\S]*scope_id: string \| null;/);
    expect(sharedAppLayout).toContain(
      'scopeId: viewContext.me.access_scope?.scope_id ?? null',
    );
    expect(sharedAppLayout).toContain('scopeId: accessScope?.scope_id ?? null');
    expect(fieldOpsApp).toContain('coerceHref(me.access_scope?.scope_id)');
    expect(fieldOpsApp).toContain('me?.access_scope?.scope_id ?? null');
  });
});
